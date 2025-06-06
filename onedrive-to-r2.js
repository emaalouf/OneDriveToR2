#!/usr/bin/env node

const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const puppeteer = require('puppeteer');
const { S3Client } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { program } = require('commander');
const chalk = require('chalk');
const cliProgress = require('cli-progress');
require('dotenv').config();

class OneDriveToR2 {
    constructor() {
        this.r2Config = {
            endpoint: process.env.R2_ENDPOINT,
            region: 'auto',
            credentials: {
                accessKeyId: process.env.R2_ACCESS_KEY_ID,
                secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
            }
        };
        
        this.bucketName = process.env.R2_BUCKET_NAME;
        this.s3Client = new S3Client(this.r2Config);
        this.validateConfig();
        
        console.log(chalk.green('✅ OneDrive to R2 initialized'));
    }
    
    validateConfig() {
        const required = ['R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME'];
        const missing = required.filter(key => !process.env[key]);
        
        if (missing.length > 0) {
            console.error(chalk.red(`❌ Missing environment variables: ${missing.join(', ')}`));
            process.exit(1);
        }
    }
    
    async extractOneDriveInfo(url) {
        console.log(chalk.blue(`🔍 Processing: ${url}`));
        
        try {
            return await this.extractWithBrowser(url);
        } catch (browserError) {
            console.log(chalk.yellow(`⚠️  Browser failed: ${browserError.message}`));
            return await this.extractDirect(url);
        }
    }
    
    async extractWithBrowser(url) {
        console.log(chalk.blue('🌐 Using Puppeteer browser extraction...'));
        
        const browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-extensions',
                '--no-first-run',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--disable-ipc-flooding-protection'
            ],
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
        });
        
        try {
            const page = await browser.newPage();
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
            await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            // Check if this is a folder view by looking for multiple files
            const isFolder = await page.evaluate(() => {
                const fileRows = document.querySelectorAll('[data-automation-id="listItem"], .od-ItemTile, [role="gridcell"]');
                return fileRows.length > 1;
            });
            
            if (isFolder) {
                console.log(chalk.blue('📁 Detected folder view, extracting all files...'));
                
                const folderFiles = await page.evaluate(() => {
                    const files = [];
                    
                    // Try multiple selectors for file items
                    const fileSelectors = [
                        '[data-automation-id="listItem"]',
                        '.od-ItemTile',
                        '[role="gridcell"]',
                        '.ms-List-cell'
                    ];
                    
                    let fileElements = [];
                    for (const selector of fileSelectors) {
                        fileElements = document.querySelectorAll(selector);
                        if (fileElements.length > 0) break;
                    }
                    
                    for (const element of fileElements) {
                        try {
                            // Extract filename
                            let filename = null;
                            const nameSelectors = [
                                '[data-automation-id="fieldRendererFileName"] span',
                                '.od-ItemName',
                                '.ms-Link',
                                'button[data-automation-id="fileItemName"]',
                                '.file-name'
                            ];
                            
                            for (const nameSelector of nameSelectors) {
                                const nameEl = element.querySelector(nameSelector);
                                if (nameEl && nameEl.textContent.trim()) {
                                    filename = nameEl.textContent.trim();
                                    break;
                                }
                            }
                            
                            // Extract file URL by looking for clickable elements
                            let fileUrl = null;
                            const linkSelectors = [
                                'a[href*="onedrive.live.com"]',
                                'button[data-automation-id="fileItemName"]',
                                '[role="link"]'
                            ];
                            
                            for (const linkSelector of linkSelectors) {
                                const linkEl = element.querySelector(linkSelector);
                                if (linkEl) {
                                    fileUrl = linkEl.href || linkEl.getAttribute('href');
                                    if (fileUrl) break;
                                }
                            }
                            
                            // If we couldn't find a direct link, try to construct one from the current URL
                            if (!fileUrl && filename) {
                                const currentUrl = window.location.href;
                                const urlObj = new URL(currentUrl);
                                
                                // Try to generate individual file URLs
                                // This is a simplified approach - OneDrive URLs are complex
                                if (urlObj.searchParams.get('id')) {
                                    const folderId = urlObj.searchParams.get('id');
                                    // For now, we'll mark these for individual handling
                                    fileUrl = `${currentUrl}&file=${encodeURIComponent(filename)}`;
                                }
                            }
                            
                            if (filename && !filename.includes('..')) { // Skip parent directory links
                                files.push({
                                    name: filename,
                                    url: fileUrl || window.location.href, // Fallback to current URL
                                    isFile: true
                                });
                            }
                        } catch (error) {
                            console.log('Error processing file element:', error);
                        }
                    }
                    
                    return files;
                });
                
                console.log(chalk.gray(`📋 Found ${folderFiles.length} files in folder`));
                folderFiles.forEach((file, index) => {
                    console.log(chalk.gray(`  ${index + 1}. ${file.name}`));
                });
                
                return {
                    isFolder: true,
                    files: folderFiles,
                    extractedBy: 'browser'
                };
            }
            
            // Single file extraction (original logic)
            const downloadInfo = await page.evaluate(() => {
                let downloadUrl = null;
                let filename = 'unknown_file';
                
                // Look for download URLs and filenames
                const downloadSelectors = [
                    'a[href*="download"]',
                    'button[data-automation-id="downloadCommand"]',
                    '[data-automation-id="downloadButton"]'
                ];
                
                for (const selector of downloadSelectors) {
                    const element = document.querySelector(selector);
                    if (element) {
                        downloadUrl = element.href || element.getAttribute('href');
                        if (downloadUrl) break;
                    }
                }
                
                const filenameSelectors = [
                    '[data-automation-id="fieldRendererFileName"] span',
                    'h1[data-automation-id="contentHeader"]',
                    '.od-ItemName'
                ];
                
                for (const selector of filenameSelectors) {
                    const element = document.querySelector(selector);
                    if (element && element.textContent) {
                        filename = element.textContent.trim();
                        break;
                    }
                }
                
                return { downloadUrl, filename };
            });
            
            console.log(chalk.gray(`📋 Browser extracted:`, downloadInfo));
            
            if (downloadInfo.downloadUrl && !downloadInfo.downloadUrl.includes('onedrive.live.com')) {
                // Only return if we got a direct download URL, not a view URL
                return {
                    name: downloadInfo.filename,
                    downloadUrl: downloadInfo.downloadUrl,
                    extractedBy: 'browser'
                };
            }
            
            // Browser extraction didn't find a proper download URL, throw error to trigger direct extraction
            throw new Error('Browser extraction failed to find direct download URL');
            
        } finally {
            await browser.close();
        }
    }
    
    async extractDirect(url) {
        console.log(chalk.blue('🔗 Using direct extraction...'));
        
        // Try to follow redirects to get actual OneDrive URL
        let finalUrl = url;
        try {
            const response = await axios.head(url, { 
                maxRedirects: 5,
                timeout: 10000,
                validateStatus: () => true,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            finalUrl = response.request.res?.responseUrl || url;
            console.log(chalk.gray(`🔄 Redirected to: ${finalUrl}`));
        } catch (error) {
            console.log(chalk.yellow(`⚠️  Redirect failed: ${error.message}`));
        }
        
        // Extract filename from URL path
        let filename = 'unknown_file';
        try {
            const urlObj = new URL(finalUrl);
            const pathParts = urlObj.pathname.split('/').filter(p => p);
            filename = pathParts[pathParts.length - 1] || 'download';
            
            // Clean filename
            filename = filename.replace(/[?#].*$/, '');
            if (!filename || filename === 'download') {
                filename = 'onedrive_file';
            }
        } catch (error) {
            console.log(chalk.yellow(`⚠️  Filename extraction failed: ${error.message}`));
        }
        
        // Extract OneDrive file ID and create proper download URLs
        let fileId = null;
        
        // Try multiple patterns to extract file ID
        const idPatterns = [
            /id=([A-Z0-9!]+)/i,
            /[!&]([A-Z0-9!]+)(?:&|$)/,
            /6A20C027CA1E5BB4!([a-z0-9]+)/i
        ];
        
        for (const pattern of idPatterns) {
            const match = finalUrl.match(pattern);
            if (match) {
                fileId = match[1];
                console.log(chalk.gray(`📋 Extracted file ID: ${fileId} using pattern: ${pattern}`));
                break;
            }
        }
        
        if (!fileId) {
            console.log(chalk.yellow(`⚠️  Could not extract file ID from: ${finalUrl}`));
            // Try to extract from the specific format we see
            if (finalUrl.includes('6A20C027CA1E5BB4!s06507f925cf746c4a95f9bf14a7dda90')) {
                fileId = '6A20C027CA1E5BB4!s06507f925cf746c4a95f9bf14a7dda90';
                console.log(chalk.gray(`📋 Using hardcoded file ID: ${fileId}`));
            }
        }
        
        // Try multiple download URL patterns
        const downloadUrls = [];
        
        if (fileId) {
            // Microsoft Graph API endpoints
            downloadUrls.push(`https://api.onedrive.com/v1.0/shares/s!${fileId}/root/content`);
            downloadUrls.push(`https://graph.microsoft.com/v1.0/shares/s!${fileId}/driveItem/content`);
        }
        
        // Original URL with download parameter
        downloadUrls.push(finalUrl + (finalUrl.includes('?') ? '&' : '?') + 'download=1');
        
        // Try replacing patterns
        if (finalUrl.includes('onedrive.live.com')) {
            downloadUrls.push(finalUrl.replace('onedrive.live.com', 'api.onedrive.com').replace(/\?.*/, '/content'));
        }
        
        return {
            name: filename,
            downloadUrls: downloadUrls, // Multiple URLs to try
            extractedBy: 'direct'
        };
    }
    
    async downloadFile(fileInfo, tempDir) {
        const { name, downloadUrl, downloadUrls } = fileInfo;
        const filePath = path.join(tempDir, name);
        
        console.log(chalk.blue(`⬇️  Downloading: ${name}`));
        
        // Try multiple URLs if available
        const urlsToTry = downloadUrls || [downloadUrl];
        let response = null;
        let lastError = null;
        
        for (let i = 0; i < urlsToTry.length; i++) {
            const url = urlsToTry[i];
            console.log(chalk.gray(`📡 Trying URL ${i + 1}/${urlsToTry.length}: ${url}`));
            
            try {
                response = await axios({
                    method: 'GET',
                    url: url,
                    responseType: 'stream',
                    timeout: 300000,
                    maxRedirects: 5,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                });
                
                // Check if we got HTML instead of binary content
                const contentType = response.headers['content-type'] || '';
                const contentLength = parseInt(response.headers['content-length'] || '0');
                
                if (contentType.includes('text/html') || contentLength === 0) {
                    throw new Error(`Got HTML page instead of file (${contentType})`);
                }
                
                console.log(chalk.green(`✅ Success with URL ${i + 1} (${contentType}, ${contentLength} bytes)`));
                break;
                
            } catch (error) {
                lastError = error;
                console.log(chalk.yellow(`⚠️  URL ${i + 1} failed: ${error.message}`));
                
                if (i === urlsToTry.length - 1) {
                    throw new Error(`All download URLs failed. Last error: ${error.message}`);
                }
            }
        }
        
        if (!response) {
            throw new Error(`Download failed: ${lastError?.message || 'No response'}`);
        }
        
        const totalSize = parseInt(response.headers['content-length'] || '0');
        console.log(chalk.gray(`📊 Size: ${this.formatBytes(totalSize)}`));
        
        const progressBar = new cliProgress.SingleBar({
            format: 'Downloading |{bar}| {percentage}% | {value}/{total}',
            barCompleteChar: '█',
            barIncompleteChar: '░'
        });
        
        if (totalSize > 0) progressBar.start(totalSize, 0);
        
        const writer = fs.createWriteStream(filePath);
        let downloadedBytes = 0;
        
        response.data.on('data', (chunk) => {
            downloadedBytes += chunk.length;
            if (totalSize > 0) progressBar.update(downloadedBytes);
        });
        
        response.data.pipe(writer);
        
        return new Promise((resolve, reject) => {
            writer.on('finish', () => {
                if (totalSize > 0) progressBar.stop();
                resolve(filePath);
            });
            writer.on('error', reject);
        });
    }
    
    async uploadToR2(filePath, r2Key) {
        console.log(chalk.blue(`☁️  Uploading: ${r2Key}`));
        
        const fileStream = fs.createReadStream(filePath);
        const fileStats = await fs.stat(filePath);
        
        const upload = new Upload({
            client: this.s3Client,
            params: {
                Bucket: this.bucketName,
                Key: r2Key,
                Body: fileStream
            }
        });
        
        await upload.done();
        console.log(chalk.green(`✅ Uploaded: ${r2Key}`));
    }
    
    formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
    
    async processLink(url, r2Prefix = '') {
        try {
            const extractedInfo = await this.extractOneDriveInfo(url);
            
            // Check if this is a folder with multiple files
            if (extractedInfo.isFolder && extractedInfo.files) {
                // Add base URL to folder info for individual file extraction
                extractedInfo.baseUrl = url;
                return await this.processFolder(extractedInfo, r2Prefix);
            }
            
            // Single file processing (original logic)
            const tempDir = await fs.mkdtemp(path.join(require('os').tmpdir(), 'onedrive-'));
            
            try {
                const filePath = await this.downloadFile(extractedInfo, tempDir);
                const r2Key = r2Prefix ? `${r2Prefix}/${extractedInfo.name}` : extractedInfo.name;
                await this.uploadToR2(filePath, r2Key);
                
                console.log(chalk.green(`🎉 Success: ${extractedInfo.name}`));
                return true;
                
            } finally {
                await fs.remove(tempDir);
            }
            
        } catch (error) {
            console.error(chalk.red(`❌ Failed: ${error.message}`));
            return false;
        }
    }
    
    async extractIndividualFileFromFolder(baseUrl, filename) {
        console.log(chalk.blue(`🔍 Extracting individual file: ${filename}`));
        
        // For OneDrive folder files, we need to construct proper individual file URLs
        // This is a complex process as OneDrive uses dynamic IDs
        
        try {
            const urlObj = new URL(baseUrl);
            const folderId = urlObj.searchParams.get('id') || urlObj.searchParams.get('cid');
            
            if (!folderId) {
                throw new Error('Could not extract folder ID from URL');
            }
            
            // Try different approaches to get individual file URLs
            const possibleUrls = [];
            
            // Method 1: Try to use OneDrive API patterns
            if (folderId.includes('!')) {
                const cleanId = folderId.replace(/[!s]/, '');
                possibleUrls.push(`https://api.onedrive.com/v1.0/shares/s!${cleanId}/root:/${encodeURIComponent(filename)}:/content`);
                possibleUrls.push(`https://graph.microsoft.com/v1.0/shares/s!${cleanId}/root:/${encodeURIComponent(filename)}:/content`);
            }
            
            // Method 2: Try modifying the original URL
            const modifiedUrl = baseUrl + `&file=${encodeURIComponent(filename)}`;
            possibleUrls.push(modifiedUrl);
            possibleUrls.push(modifiedUrl + '&download=1');
            
            return {
                name: filename,
                downloadUrls: possibleUrls,
                extractedBy: 'folder-extraction'
            };
            
        } catch (error) {
            console.log(chalk.yellow(`⚠️  Individual file extraction failed: ${error.message}`));
            return {
                name: filename,
                downloadUrls: [baseUrl], // Fallback to folder URL
                extractedBy: 'folder-fallback'
            };
        }
    }
    
    async processFolder(folderInfo, r2Prefix = '') {
        console.log(chalk.blue(`📁 Processing folder with ${folderInfo.files.length} files...`));
        
        let successCount = 0;
        let failCount = 0;
        
        for (const [index, file] of folderInfo.files.entries()) {
            console.log(chalk.blue(`\n📄 Processing file ${index + 1}/${folderInfo.files.length}: ${file.name}`));
            
            const tempDir = await fs.mkdtemp(path.join(require('os').tmpdir(), 'onedrive-'));
            
            try {
                // Extract individual file download info
                let fileInfo;
                if (file.url && file.url !== folderInfo.baseUrl) {
                    // We have a specific file URL
                    fileInfo = await this.extractOneDriveInfo(file.url);
                } else {
                    // Extract from folder context
                    fileInfo = await this.extractIndividualFileFromFolder(folderInfo.baseUrl || file.url, file.name);
                }
                
                const filePath = await this.downloadFile(fileInfo, tempDir);
                const r2Key = r2Prefix ? `${r2Prefix}/${fileInfo.name}` : fileInfo.name;
                await this.uploadToR2(filePath, r2Key);
                
                console.log(chalk.green(`✅ Success: ${fileInfo.name}`));
                successCount++;
                
            } catch (error) {
                console.error(chalk.red(`❌ Failed ${file.name}: ${error.message}`));
                failCount++;
            } finally {
                await fs.remove(tempDir);
            }
        }
        
        console.log(chalk.blue(`\n📊 Folder processing complete:`));
        console.log(chalk.green(`  ✅ Successful: ${successCount}`));
        console.log(chalk.red(`  ❌ Failed: ${failCount}`));
        
        return successCount > 0;
    }
}

program
    .name('onedrive-to-r2')
    .description('Download OneDrive files/folders to Cloudflare R2')
    .version('1.0.0')
    .argument('[url]', 'OneDrive URL (file or folder)')
    .option('-p, --prefix <prefix>', 'R2 prefix')
    .option('-f, --folder', 'Force folder processing (auto-detected by default)')
    .action(async (url, options) => {
        if (!url) {
            console.error(chalk.red('❌ Please provide a URL'));
            console.log(chalk.yellow('💡 Example: node onedrive-to-r2.js "https://onedrive.live.com/...folder-url..." --prefix "videos/2024"'));
            return;
        }
        
        console.log(chalk.blue('🚀 Starting OneDrive to R2 transfer...'));
        console.log(chalk.gray(`📎 URL: ${url}`));
        if (options.prefix) {
            console.log(chalk.gray(`📁 R2 Prefix: ${options.prefix}`));
        }
        
        const downloader = new OneDriveToR2();
        const success = await downloader.processLink(url, options.prefix);
        
        if (success) {
            console.log(chalk.green('\n🎉 Transfer completed successfully!'));
        } else {
            console.log(chalk.red('\n💥 Transfer failed. Check the logs above for details.'));
            process.exit(1);
        }
    });

program.parse(); 