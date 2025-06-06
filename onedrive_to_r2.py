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
        original_url = url
        
        # Convert 1drv.ms short URLs to full URLs
        if '1drv.ms' in url:
            print(f"Following redirect for short URL...")
            response = self.session.get(url, allow_redirects=True)
            url = response.url
            print(f"Redirected to: {url}")
        
        # Extract file ID from URL - try multiple patterns
        file_id = None
        
        # Pattern 1: resid= parameter
        if 'resid=' in url:
            file_id = url.split('resid=')[1].split('&')[0]
            print(f"Found file ID via resid: {file_id}")
        
        # Pattern 2: /redir? URLs
        elif '/redir?' in url:
            parsed = urlparse(url)
            params = parse_qs(parsed.query)
            file_id = params.get('resid', [None])[0]
            print(f"Found file ID via redir: {file_id}")
        
        # Pattern 3: id= parameter
        elif 'id=' in url:
            match = re.search(r'[?&]id=([^&]+)', url)
            if match:
                file_id = match.group(1)
                print(f"Found file ID via id param: {file_id}")
        
        # Pattern 4: Extract from 1drv.ms path (format: /t/c/id1/id2)
        elif '1drv.ms' in original_url:
            # Try to extract from the original 1drv.ms URL path
            path_match = re.search(r'1drv\.ms/[a-z]/[a-z]/([^/]+)/([^/?]+)', original_url)
            if path_match:
                # Combine the two IDs found in the path
                id1, id2 = path_match.groups()
                file_id = f"{id1}!{id2.replace('_', '%21').replace('-', '%2D')}"
                print(f"Extracted file ID from 1drv.ms path: {file_id}")
        
        # Pattern 5: Try to find any ID-like string in the URL
        if not file_id:
            # Look for long alphanumeric strings that could be file IDs
            id_matches = re.findall(r'[A-Za-z0-9_-]{20,}', url)
            if id_matches:
                file_id = id_matches[0]
                print(f"Found potential file ID: {file_id}")
        
        if not file_id:
            print("Could not extract file ID, trying direct download approach...")
            return self._get_direct_download_url(original_url)
        
        # Try Microsoft Graph API first
        try:
            api_url = f"https://api.onedrive.com/v1.0/shares/s!{file_id}/root"
            print(f"Trying Graph API: {api_url}")
            
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
                print(f"Graph API failed with status {response.status_code}")
        except Exception as e:
            print(f"Graph API error: {e}")
        
        # Fallback: try to get download URL directly
        print("Falling back to direct download URL extraction...")
        return self._get_direct_download_url(original_url)

    def _extract_sharepoint_info(self, url: str) -> Dict[str, Any]:
        """Extract info from SharePoint OneDrive URLs."""
        # This is more complex and may require different handling
        # For now, try the direct approach
        return self._get_direct_download_url(url)

    def _get_direct_download_url(self, url: str) -> Dict[str, Any]:
        """Get direct download URL by parsing the page."""
        print(f"Attempting direct download URL extraction from: {url}")
        
        try:
            response = self.session.get(url)
            response.raise_for_status()
            
            # Look for download URL in the page content
            content = response.text
            
            # Try multiple patterns to find filename
            filename = "downloaded_file"
            filename_patterns = [
                r'"name":\s*"([^"]+)"',
                r'"fileName":\s*"([^"]+)"',
                r'"title":\s*"([^"]+)"',
                r'<title>([^<]+)</title>',
                r'data-filename="([^"]+)"',
                r'"displayName":\s*"([^"]+)"'
            ]
            
            for pattern in filename_patterns:
                match = re.search(pattern, content, re.IGNORECASE)
                if match:
                    potential_filename = match.group(1).strip()
                    # Skip generic Microsoft/OneDrive titles
                    if not re.match(r'^(Microsoft|OneDrive|Shared)', potential_filename, re.IGNORECASE):
                        filename = potential_filename
                        # Clean up filename from HTML entities and extra text
                        filename = re.sub(r'\s*-\s*OneDrive.*$', '', filename)
                        filename = re.sub(r'\s*\|\s*Microsoft.*$', '', filename)
                        break
            
            # If we still have a generic name, try to extract from URL path
            if filename in ["downloaded_file", "Microsoft OneDrive"]:
                # Look for filename in the URL path or ID
                url_match = re.search(r'/([^/?]+)\?', url)
                if url_match:
                    url_part = url_match.group(1)
                    if len(url_part) > 5 and not re.match(r'^[A-Z0-9_-]+$', url_part):
                        filename = url_part
            
            print(f"Extracted filename: {filename}")
            
            # Try multiple patterns to find download URL
            download_url = None
            download_patterns = [
                r'"@microsoft\.graph\.downloadUrl":\s*"([^"]+)"',
                r'"downloadUrl":\s*"([^"]+)"',
                r'"@content\.downloadUrl":\s*"([^"]+)"',
                r'href="([^"]*download[^"]*)"',
                r'"url":\s*"([^"]*download[^"]*)"'
            ]
            
            for pattern in download_patterns:
                match = re.search(pattern, content, re.IGNORECASE)
                if match:
                    download_url = match.group(1)
                    # Clean up URL encoding
                    download_url = download_url.replace('\\u0026', '&')
                    download_url = download_url.replace('\\/', '/')
                    print(f"Found download URL via pattern: {download_url}")
                    break
            
            if download_url:
                return {
                    'name': filename,
                    'download_url': download_url,
                    'size': 0,  # Will be determined during download
                    'file_id': 'direct'
                }
            
            # Alternative 1: Try adding download=1 parameter
            if 'download=1' not in url and 'dl=1' not in url:
                test_urls = [
                    url + ('&' if '?' in url else '?') + 'download=1',
                    url + ('&' if '?' in url else '?') + 'dl=1',
                    url.replace('1drv.ms/', '1drv.ms/download/')
                ]
                
                for test_url in test_urls:
                    print(f"Trying download URL: {test_url}")
                    try:
                        test_response = self.session.head(test_url, allow_redirects=True)
                        if test_response.status_code == 200:
                            content_type = test_response.headers.get('content-type', '')
                            if not content_type.startswith('text/html'):
                                return {
                                    'name': filename,
                                    'download_url': test_url,
                                    'size': int(test_response.headers.get('content-length', 0)),
                                    'file_id': 'direct'
                                }
                    except Exception as e:
                        print(f"Test URL failed: {e}")
                        continue
            
            # Alternative 2: Look for iframe or embed URLs
            iframe_match = re.search(r'<iframe[^>]+src="([^"]+)"', content, re.IGNORECASE)
            if iframe_match:
                iframe_url = iframe_match.group(1)
                print(f"Found iframe URL, trying: {iframe_url}")
                return self._get_direct_download_url(iframe_url)
            
        except Exception as e:
            print(f"Error in direct download extraction: {e}")
        
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
        
        # Validate URL format
        if not onedrive_url.startswith(('http://', 'https://')):
            print("❌ Invalid URL format - must start with http:// or https://")
            return False
        
        # Check for incomplete URLs (missing required parameters)
        if 'onedrive.live.com' in onedrive_url and '&' not in onedrive_url and 'id=' not in onedrive_url:
            print("❌ URL appears incomplete - did you forget to quote it in the shell?")
            print("💡 Tip: Use quotes around the URL: python3 onedrive_to_r2.py \"your-url-here\"")
            return False
        
        # Check for folder URLs
        if 'onedrive.live.com' in onedrive_url and ('o=OneUp' in onedrive_url or 'sb=' in onedrive_url or 'parId=' in onedrive_url):
            print("❌ This appears to be a OneDrive folder URL, not a file URL")
            print("💡 To download files:")
            print("   1. Go to your OneDrive folder in the browser")
            print("   2. Right-click on individual files → 'Copy link' or 'Share'")
            print("   3. Use those direct file links with this script")
            print("   4. Or put multiple file links in links.txt and use --file option")
            return False
        
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