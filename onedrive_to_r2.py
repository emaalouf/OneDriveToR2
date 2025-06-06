#!/usr/bin/env python3
"""
OneDrive to Cloudflare R2 Downloader
Downloads files from OneDrive links and uploads them to Cloudflare R2 storage.
"""

import os
import re
import requests
import boto3
from urllib.parse import urlparse, parse_qs
from pathlib import Path
import tempfile
import json
from typing import Optional, Dict, Any
from tqdm import tqdm
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

class OneDriveToR2:
    def __init__(self):
        # R2 Configuration
        self.r2_endpoint = os.getenv('R2_ENDPOINT_URL')
        self.r2_access_key = os.getenv('R2_ACCESS_KEY_ID')
        self.r2_secret_key = os.getenv('R2_SECRET_ACCESS_KEY')
        self.r2_bucket = os.getenv('R2_BUCKET_NAME')
        
        if not all([self.r2_endpoint, self.r2_access_key, self.r2_secret_key, self.r2_bucket]):
            raise ValueError("Missing required R2 configuration. Please check your .env file.")
        
        # Initialize R2 client
        self.r2_client = boto3.client(
            's3',
            endpoint_url=self.r2_endpoint,
            aws_access_key_id=self.r2_access_key,
            aws_secret_access_key=self.r2_secret_key,
            region_name='auto'
        )
        
        # Session for requests
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        })

    def extract_onedrive_info(self, url: str) -> Dict[str, Any]:
        """Extract OneDrive file information from the URL."""
        try:
            # Handle different OneDrive URL formats
            if 'onedrive.live.com' in url or '1drv.ms' in url:
                return self._extract_live_onedrive_info(url)
            elif 'sharepoint.com' in url:
                return self._extract_sharepoint_info(url)
            else:
                raise ValueError(f"Unsupported OneDrive URL format: {url}")
        except Exception as e:
            print(f"Error extracting OneDrive info: {e}")
            return {}

    def _extract_live_onedrive_info(self, url: str) -> Dict[str, Any]:
        """Extract info from onedrive.live.com URLs."""
        # Convert 1drv.ms short URLs to full URLs
        if '1drv.ms' in url:
            response = self.session.head(url, allow_redirects=True)
            url = response.url
        
        # Extract file ID from URL
        if 'resid=' in url:
            file_id = url.split('resid=')[1].split('&')[0]
        elif '/redir?' in url:
            # Parse redirect URL
            parsed = urlparse(url)
            params = parse_qs(parsed.query)
            file_id = params.get('resid', [None])[0]
        else:
            # Try to extract from path
            match = re.search(r'[?&]id=([^&]+)', url)
            if match:
                file_id = match.group(1)
            else:
                raise ValueError("Could not extract file ID from URL")
        
        # Get file metadata
        api_url = f"https://api.onedrive.com/v1.0/shares/s!{file_id}/root"
        
        response = self.session.get(api_url)
        if response.status_code == 200:
            metadata = response.json()
            return {
                'name': metadata.get('name', 'unknown_file'),
                'download_url': metadata.get('@microsoft.graph.downloadUrl'),
                'size': metadata.get('size', 0),
                'file_id': file_id
            }
        else:
            # Fallback: try to get download URL directly
            return self._get_direct_download_url(url)

    def _extract_sharepoint_info(self, url: str) -> Dict[str, Any]:
        """Extract info from SharePoint OneDrive URLs."""
        # This is more complex and may require different handling
        # For now, try the direct approach
        return self._get_direct_download_url(url)

    def _get_direct_download_url(self, url: str) -> Dict[str, Any]:
        """Get direct download URL by parsing the page."""
        response = self.session.get(url)
        response.raise_for_status()
        
        # Look for download URL in the page content
        content = response.text
        
        # Try to find filename
        filename_match = re.search(r'"name":\s*"([^"]+)"', content)
        filename = filename_match.group(1) if filename_match else "downloaded_file"
        
        # Try to find direct download URL
        download_match = re.search(r'"@microsoft\.graph\.downloadUrl":\s*"([^"]+)"', content)
        if download_match:
            download_url = download_match.group(1).replace('\\u0026', '&')
            return {
                'name': filename,
                'download_url': download_url,
                'size': 0,  # Will be determined during download
                'file_id': 'unknown'
            }
        
        # Alternative: try to construct download URL
        if 'download=1' not in url:
            download_url = url + ('&' if '?' in url else '?') + 'download=1'
            return {
                'name': filename,
                'download_url': download_url,
                'size': 0,
                'file_id': 'unknown'
            }
        
        raise ValueError("Could not extract download URL")

    def download_file(self, file_info: Dict[str, Any], temp_dir: str) -> str:
        """Download file from OneDrive to temporary directory."""
        download_url = file_info['download_url']
        filename = file_info['name']
        
        print(f"Downloading: {filename}")
        
        response = self.session.get(download_url, stream=True)
        response.raise_for_status()
        
        # Get file size from headers if not available
        if file_info['size'] == 0:
            file_info['size'] = int(response.headers.get('content-length', 0))
        
        # Save to temporary file
        temp_file_path = os.path.join(temp_dir, filename)
        
        with open(temp_file_path, 'wb') as f:
            if file_info['size'] > 0:
                with tqdm(total=file_info['size'], unit='B', unit_scale=True, desc=filename) as pbar:
                    for chunk in response.iter_content(chunk_size=8192):
                        if chunk:
                            f.write(chunk)
                            pbar.update(len(chunk))
            else:
                for chunk in response.iter_content(chunk_size=8192):
                    if chunk:
                        f.write(chunk)
        
        print(f"Downloaded: {temp_file_path}")
        return temp_file_path

    def upload_to_r2(self, file_path: str, r2_key: str) -> bool:
        """Upload file to Cloudflare R2."""
        try:
            file_size = os.path.getsize(file_path)
            
            print(f"Uploading to R2: {r2_key}")
            
            # Upload with progress bar
            with open(file_path, 'rb') as f:
                with tqdm(total=file_size, unit='B', unit_scale=True, desc=f"Uploading {os.path.basename(file_path)}") as pbar:
                    def callback(bytes_transferred):
                        pbar.update(bytes_transferred)
                    
                    self.r2_client.upload_fileobj(
                        f, 
                        self.r2_bucket, 
                        r2_key,
                        Callback=callback
                    )
            
            print(f"Successfully uploaded: {r2_key}")
            return True
            
        except Exception as e:
            print(f"Error uploading to R2: {e}")
            return False

    def process_link(self, onedrive_url: str, r2_prefix: str = "") -> bool:
        """Process a single OneDrive link."""
        print(f"\nProcessing: {onedrive_url}")
        
        try:
            # Extract file information
            file_info = self.extract_onedrive_info(onedrive_url)
            if not file_info:
                print("Could not extract file information")
                return False
            
            print(f"File info: {file_info['name']} ({file_info.get('size', 'unknown size')} bytes)")
            
            # Download file to temporary directory
            with tempfile.TemporaryDirectory() as temp_dir:
                local_file_path = self.download_file(file_info, temp_dir)
                
                # Construct R2 key
                r2_key = os.path.join(r2_prefix, file_info['name']).replace('\\', '/')
                if r2_key.startswith('/'):
                    r2_key = r2_key[1:]
                
                # Upload to R2
                success = self.upload_to_r2(local_file_path, r2_key)
                
                if success:
                    print(f"✅ Successfully processed: {file_info['name']}")
                    return True
                else:
                    print(f"❌ Failed to upload: {file_info['name']}")
                    return False
                    
        except Exception as e:
            print(f"❌ Error processing link: {e}")
            return False

    def process_links_from_file(self, file_path: str, r2_prefix: str = "") -> Dict[str, bool]:
        """Process multiple OneDrive links from a file."""
        results = {}
        
        try:
            with open(file_path, 'r') as f:
                links = [line.strip() for line in f if line.strip() and not line.startswith('#')]
            
            print(f"Found {len(links)} links to process")
            
            for i, link in enumerate(links, 1):
                print(f"\n{'='*50}")
                print(f"Processing link {i}/{len(links)}")
                results[link] = self.process_link(link, r2_prefix)
                
        except FileNotFoundError:
            print(f"File not found: {file_path}")
            
        return results

def main():
    """Main function for command line usage."""
    import sys
    
    if len(sys.argv) < 2:
        print("Usage:")
        print("  python onedrive_to_r2.py <onedrive_url> [r2_prefix]")
        print("  python onedrive_to_r2.py --file <links_file> [r2_prefix]")
        print("\nEnvironment variables required:")
        print("  R2_ENDPOINT_URL")
        print("  R2_ACCESS_KEY_ID") 
        print("  R2_SECRET_ACCESS_KEY")
        print("  R2_BUCKET_NAME")
        return
    
    try:
        downloader = OneDriveToR2()
        
        if sys.argv[1] == '--file':
            if len(sys.argv) < 3:
                print("Please specify the links file")
                return
            
            links_file = sys.argv[2]
            r2_prefix = sys.argv[3] if len(sys.argv) > 3 else ""
            
            results = downloader.process_links_from_file(links_file, r2_prefix)
            
            print(f"\n{'='*50}")
            print("SUMMARY")
            print(f"{'='*50}")
            
            successful = sum(1 for success in results.values() if success)
            total = len(results)
            
            print(f"Total links: {total}")
            print(f"Successful: {successful}")
            print(f"Failed: {total - successful}")
            
        else:
            onedrive_url = sys.argv[1]
            r2_prefix = sys.argv[2] if len(sys.argv) > 2 else ""
            
            success = downloader.process_link(onedrive_url, r2_prefix)
            if success:
                print("\n✅ Link processed successfully!")
            else:
                print("\n❌ Failed to process link")
                sys.exit(1)
                
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main() 