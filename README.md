# OneDrive to R2 Transfer Tool

A Node.js tool to download OneDrive folders/files and upload them to Cloudflare R2 storage.

## Features

- Download OneDrive folders as ZIP files
- Upload to Cloudflare R2 storage
- Authentication support for private OneDrive links
- Browser automation using Puppeteer
- Comprehensive error handling and debugging

## Setup

1. Install dependencies:
```bash
npm install fs-extra axios puppeteer @aws-sdk/client-s3 @aws-sdk/lib-storage commander chalk cli-progress dotenv
```

2. Copy and configure environment variables:
```bash
cp .env.example .env
```

3. Edit `.env` with your credentials:
```
# Required: Cloudflare R2 Configuration
R2_ENDPOINT=https://your-account-id.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=your-r2-access-key-id
R2_SECRET_ACCESS_KEY=your-r2-secret-access-key
R2_BUCKET_NAME=your-bucket-name

# Optional but recommended: OneDrive Authentication
ONEDRIVE_EMAIL=your-email@example.com
ONEDRIVE_PASSWORD=your-password
```

## Usage

### Simple folder download (with authentication via environment):
```bash
node onedrive-to-r2-simple.js "https://onedrive.live.com/...folder-url..." --prefix "my-folder"
```

### With command-line authentication:
```bash
node onedrive-to-r2-simple.js "https://onedrive.live.com/...folder-url..." --email "your@email.com" --password "yourpassword" --prefix "my-folder"
```

### Advanced usage (original script):
```bash
node onedrive-to-r2.js "https://onedrive.live.com/...folder-url..." --prefix "my-folder"
```

## Authentication

Authentication is **highly recommended** for private OneDrive links. Without authentication, you may encounter:
- `GraphError: Unauthenticated`
- `GraphError: User migrated`
- Missing download buttons

You can provide authentication in two ways:

1. **Environment variables** (recommended for security):
   - Set `ONEDRIVE_EMAIL` and `ONEDRIVE_PASSWORD` in `.env` file

2. **Command line options**:
   - Use `--email` and `--password` flags

## Debugging

To debug browser automation issues:
```bash
PUPPETEER_HEADLESS=false node onedrive-to-r2-simple.js "your-url"
```

This will open a visible browser window and save debug screenshots.

## Error Handling

Common issues and solutions:

- **Authentication errors**: Provide valid OneDrive credentials
- **Download button not found**: Try with authentication
- **Timeout errors**: Check internet connection and OneDrive link validity
- **R2 upload errors**: Verify R2 credentials and bucket permissions

## Scripts

- `onedrive-to-r2-simple.js`: Simplified script for downloading entire folders as ZIP
- `onedrive-to-r2.js`: Advanced script with individual file processing capabilities 