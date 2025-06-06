# OneDrive to Cloudflare R2 Downloader

A Python tool that downloads files from OneDrive sharing links and uploads them to Cloudflare R2 storage. Processes links one by one with progress tracking and error handling.

## Features

- ✅ Downloads files from OneDrive sharing links
- ✅ Supports multiple OneDrive URL formats:
  - `onedrive.live.com` URLs
  - `1drv.ms` short URLs  
  - SharePoint OneDrive URLs
- ✅ Uploads to Cloudflare R2 with progress bars
- ✅ Process single links or batch process from file
- ✅ Automatic file cleanup (uses temporary storage)
- ✅ Error handling and retry logic
- ✅ Progress tracking for downloads and uploads

## Prerequisites

- Python 3.7 or higher
- Cloudflare R2 bucket and API credentials

## Installation

1. Clone or download this repository
2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

3. Set up your environment variables by copying the example file:
   ```bash
   cp .env.example .env
   ```

4. Edit `.env` with your Cloudflare R2 credentials:
   ```env
   R2_ENDPOINT_URL=https://your-account-id.r2.cloudflarestorage.com
   R2_ACCESS_KEY_ID=your_access_key_id
   R2_SECRET_ACCESS_KEY=your_secret_access_key
   R2_BUCKET_NAME=your-bucket-name
   ```

## Getting R2 Credentials

1. Go to your [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Navigate to **R2 Object Storage**
3. Create a bucket if you haven't already
4. Go to **Manage R2 API tokens**
5. Create a new API token with permissions for your bucket
6. Note down:
   - Account ID (for the endpoint URL)
   - Access Key ID
   - Secret Access Key
   - Bucket name

## Usage

### Process a Single Link

```bash
python onedrive_to_r2.py "https://onedrive.live.com/download?cid=ABC123&resid=ABC123%21456"
```

With a custom R2 prefix/folder:
```bash
python onedrive_to_r2.py "https://onedrive.live.com/download?cid=ABC123&resid=ABC123%21456" "my-folder"
```

### Process Multiple Links from File

1. Create a text file with OneDrive links (one per line):
   ```
   https://onedrive.live.com/download?cid=ABC123&resid=ABC123%21456
   https://1drv.ms/u/s!shortlinkexample
   https://company-my.sharepoint.com/:u:/g/personal/user_company_com/EaBcDefGhIjKlMnOpQrStUvWxYz?e=AbCdEf
   ```

2. Process all links:
   ```bash
   python onedrive_to_r2.py --file links.txt
   ```

   With a custom R2 prefix:
   ```bash
   python onedrive_to_r2.py --file links.txt "backup-folder"
   ```

### Example Links File Format

```txt
# OneDrive Links File
# Lines starting with # are ignored
# Add one link per line

https://onedrive.live.com/download?cid=ABC123&resid=ABC123%21456&authkey=xyz
https://1drv.ms/u/s!AiBcDeFgHiJkLmNoPqRsTuVwXyZ
https://yourcompany-my.sharepoint.com/:u:/g/personal/user_company_com/EaBcDefGhIjKlMnOpQrStUvWxYz?e=AbCdEf
```

## Supported OneDrive URL Formats

- **Personal OneDrive**: `https://onedrive.live.com/...`
- **Short URLs**: `https://1drv.ms/...`
- **SharePoint OneDrive**: `https://company-my.sharepoint.com/...`
- **Business OneDrive**: Various enterprise formats

## How It Works

1. **Link Analysis**: Extracts file metadata from OneDrive URLs
2. **Download**: Downloads files to temporary storage with progress tracking
3. **Upload**: Uploads files to Cloudflare R2 with progress tracking  
4. **Cleanup**: Automatically removes temporary files

## Error Handling

- Invalid or inaccessible URLs are skipped with error messages
- Network errors are logged and processing continues
- Failed uploads are reported but don't stop batch processing
- Detailed error messages help with troubleshooting

## File Organization in R2

Files are uploaded to R2 with the following structure:
- Without prefix: `filename.ext`
- With prefix: `prefix/filename.ext`

## Limitations

- Only processes files that are publicly accessible via sharing links
- Some OneDrive URLs may require additional authentication
- Large files may take time to process
- Rate limiting may apply for high-volume processing

## Troubleshooting

### Common Issues

1. **Missing R2 credentials**: Make sure your `.env` file is configured correctly
2. **Access denied**: Verify OneDrive links are publicly accessible
3. **Network errors**: Check your internet connection and R2 endpoint URL
4. **File not found**: Ensure OneDrive links are valid and files still exist

### Debug Mode

For debugging, you can modify the script to add more verbose logging or run individual functions.

## Contributing

Feel free to submit issues and enhancement requests!

## License

This project is open source and available under the MIT License. 