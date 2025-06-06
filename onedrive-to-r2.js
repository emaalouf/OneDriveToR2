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
        console.log(chalk.blue('🌐 Using Puppeteer browser download...'));
        
        const downloadPath = path.join(require('os').tmpdir(), 'onedrive-downloads-' + Date.now());
        await fs.ensureDir(downloadPath);
        
        const browser = await puppeteer.launch({
            headless: process.env.PUPPETEER_HEADLESS !== 'false', // Allow debugging with PUPPETEER_HEADLESS=false
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
            
            // Set download path using modern Puppeteer API
            const client = await page.target().createCDPSession();
            await client.send('Page.setDownloadBehavior', {
                behavior: 'allow',
                downloadPath: downloadPath
            });
            
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
            await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
            
            // Check if we're redirected to login page
            const currentUrl = page.url();
            if (currentUrl.includes('login.live.com') || currentUrl.includes('login.microsoftonline.com')) {
                console.log(chalk.yellow('🔐 Detected login redirect. Trying anonymous access...'));
                
                // Try to access without authentication by modifying the URL
                const originalUrl = new URL(url);
                const fileId = originalUrl.searchParams.get('id');
                
                if (fileId) {
                    // Try different anonymous access patterns
                    const anonymousUrls = [
                        `https://onedrive.live.com/embed?cid=${fileId}&authkey=!${fileId}`,
                        `https://onedrive.live.com/download?cid=${fileId}`,
                        `https://onedrive.live.com/redir?cid=${fileId}&authkey=!${fileId}`,
                        url + '&authkey=anonymous'
                    ];
                    
                    for (const testUrl of anonymousUrls) {
                        try {
                            console.log(chalk.blue(`🔄 Trying anonymous URL: ${testUrl}`));
                            await page.goto(testUrl, { waitUntil: 'networkidle2', timeout: 15000 });
                            
                            const newUrl = page.url();
                            if (!newUrl.includes('login.live.com') && !newUrl.includes('login.microsoftonline.com')) {
                                console.log(chalk.green('✅ Successfully bypassed login!'));
                                break;
                            }
                        } catch (error) {
                            console.log(chalk.yellow(`⚠️  Anonymous URL failed: ${error.message}`));
                        }
                    }
                }
                
                // If still on login page, throw error with instructions
                const finalUrl = page.url();
                if (finalUrl.includes('login.live.com') || finalUrl.includes('login.microsoftonline.com')) {
                    throw new Error(`OneDrive link requires authentication. Please:
1. Open OneDrive in browser
2. Right-click the folder "Grounding" 
3. Select "Share" > "Anyone with the link"
4. Set to "Can view" or "Can download"
5. Copy the new public link and try again`);
                }
            }
            
            await new Promise(resolve => setTimeout(resolve, 5000)); // Wait longer for OneDrive to load
            
            // Take a screenshot for debugging
            try {
                await page.screenshot({ path: path.join(downloadPath, 'debug-screenshot.png') });
                console.log(chalk.gray(`📷 Debug screenshot saved to: ${downloadPath}/debug-screenshot.png`));
            } catch (screenshotError) {
                console.log(chalk.yellow(`⚠️  Could not take screenshot: ${screenshotError.message}`));
            }
            
            // Check if this is a folder view by looking for multiple files
            const folderDetection = await page.evaluate(() => {
                // Multiple detection methods for folder view
                const fileRows = document.querySelectorAll('[data-automation-id="listItem"], .od-ItemTile, [role="gridcell"]');
                const listView = document.querySelector('[data-automation-id="detailsList"]');
                const folderIndicators = document.querySelectorAll('[data-icon-name="FabricFolder"], .ms-Icon--FabricFolder');
                
                // Look for specific OneDrive folder elements
                const breadcrumb = document.querySelector('[data-automation-id="breadcrumb"]');
                const fileList = document.querySelector('[data-automation-id="fileList"]');
                const commandBar = document.querySelector('[data-automation-id="commandBar"]');
                
                // Check URL patterns
                const url = window.location.href;
                const hasIdParam = url.includes('id=') && !url.includes('file=');
                const isSharedView = url.includes('onedrive.live.com') && (url.includes('sb=') || url.includes('cid='));
                
                // Look for file entries in different ways
                const allButtons = document.querySelectorAll('button');
                const fileButtons = Array.from(allButtons).filter(btn => 
                    btn.textContent && 
                    (btn.textContent.includes('.mp4') || btn.textContent.includes('.avi') || btn.textContent.includes('.mov'))
                );
                
                // Look for any elements that might contain filenames
                const allText = document.body.innerText;
                const videoFiles = (allText.match(/\.(mp4|avi|mov|mkv|wmv)/gi) || []).length;
                
                const result = {
                    fileRowsCount: fileRows.length,
                    hasListView: !!listView,
                    folderIndicators: folderIndicators.length,
                    hasBreadcrumb: !!breadcrumb,
                    hasFileList: !!fileList,
                    hasCommandBar: !!commandBar,
                    hasIdParam,
                    isSharedView,
                    fileButtonsCount: fileButtons.length,
                    videoFilesInText: videoFiles,
                    url: url,
                    title: document.title
                };
                
                console.log('Folder detection results:', result);
                
                // More comprehensive folder detection
                const isFolder = fileRows.length > 1 || 
                               !!listView || 
                               folderIndicators.length > 0 ||
                               fileButtons.length > 1 ||
                               videoFiles > 1 ||
                               (isSharedView && hasIdParam && !url.includes('file=')) ||
                               // Force folder mode for URLs with sb= parameter (sort by)
                               url.includes('sb=') ||
                               // Force folder mode for URLs with sd= parameter (sort direction)
                               url.includes('sd=');
                
                return { isFolder, details: result };
            });
            
            console.log(chalk.gray(`🔍 Folder detection: ${folderDetection.isFolder ? 'FOLDER' : 'SINGLE FILE'}`));
            console.log(chalk.gray(`📋 Details:`, JSON.stringify(folderDetection.details, null, 2)));
            
            // Save HTML for debugging if needed
            try {
                const htmlContent = await page.content();
                await fs.writeFile(path.join(downloadPath, 'debug-page.html'), htmlContent);
                console.log(chalk.gray(`📄 HTML content saved to: ${downloadPath}/debug-page.html`));
            } catch (htmlError) {
                console.log(chalk.yellow(`⚠️  Could not save HTML: ${htmlError.message}`));
            }
            
            const isFolder = folderDetection.isFolder;
            
            if (isFolder) {
                console.log(chalk.blue('📁 Detected folder view, attempting folder download...'));
                
                // First try to download the entire folder as ZIP
                const folderDownloadResult = await page.evaluate(() => {
                    // Look for folder download button with comprehensive search
                    const allElements = document.querySelectorAll('*');
                    const downloadButtons = [];
                    
                    // Find all potential download buttons
                    for (const element of allElements) {
                        const text = element.textContent || '';
                        const ariaLabel = element.getAttribute('aria-label') || '';
                        const title = element.getAttribute('title') || '';
                        const dataAutomationId = element.getAttribute('data-automation-id') || '';
                        
                        if (
                            text.toLowerCase().includes('download') ||
                            ariaLabel.toLowerCase().includes('download') ||
                            title.toLowerCase().includes('download') ||
                            dataAutomationId.includes('download') ||
                            element.querySelector('[data-icon-name*="Download"]')
                        ) {
                            downloadButtons.push({
                                element: element,
                                text: text.substring(0, 50),
                                ariaLabel: ariaLabel,
                                title: title,
                                tag: element.tagName,
                                dataAutomationId: dataAutomationId
                            });
                        }
                    }
                    
                    console.log('Found potential download buttons:', downloadButtons.length);
                    downloadButtons.forEach((btn, i) => {
                        console.log(`  ${i + 1}. ${btn.tag} - ${btn.text} (${btn.ariaLabel || btn.title})`);
                    });
                    
                    // Try clicking the most likely download button
                    for (const btnInfo of downloadButtons) {
                        const btn = btnInfo.element;
                        if (btn.tagName === 'BUTTON' || btn.tagName === 'A' || btn.role === 'button') {
                            try {
                                console.log('Attempting to click:', btnInfo);
                                btn.click();
                                return { success: true, type: 'folder-zip', clicked: btnInfo };
                            } catch (clickError) {
                                console.log('Click failed:', clickError.message);
                            }
                        }
                    }
                    
                    return { success: false, reason: 'No clickable download button found', foundButtons: downloadButtons.length };
                });
                
                if (folderDownloadResult.success) {
                    console.log(chalk.green('✅ Folder download initiated, waiting for ZIP file...'));
                    
                    try {
                        // Wait for ZIP download to complete
                        const zipFile = await this.waitForDownload(downloadPath, 'folder.zip', 60000);
                        
                        return {
                            isFolder: true,
                            isFolderZip: true,
                            zipFile: zipFile,
                            downloadPath: downloadPath,
                            extractedBy: 'browser-download'
                        };
                        
                    } catch (zipError) {
                        console.log(chalk.yellow(`⚠️  Folder ZIP download failed: ${zipError.message}`));
                        console.log(chalk.blue('📄 Falling back to individual file downloads...'));
                    }
                }
                
                                // Simplified approach: Try to download the entire folder as ZIP
                console.log(chalk.blue('🗜️  Attempting to download entire folder as ZIP...'));
                
                const zipDownloadResult = await page.evaluate(() => {
                    // Wait a bit for page to fully load
                    return new Promise((resolve) => {
                        setTimeout(() => {
                            try {
                                // Just try to find ANY download button and click it
                                console.log('Looking for download buttons...');
                                
                                // First, try to select all files (Ctrl+A equivalent)
                                const selectAllButton = document.querySelector('[data-automation-id="selectAllCommand"]');
                                if (selectAllButton) {
                                    console.log('Found select all button, clicking...');
                                    selectAllButton.click();
                                }
                                
                                // Give it a moment
                                setTimeout(() => {
                                    // Now look for download button
                                    const downloadButtons = [
                                        'button[data-automation-id="downloadCommand"]',
                                        '[data-automation-id="downloadButton"]',
                                        'button[aria-label*="Download"]',
                                        'button[title*="Download"]',
                                        '.ms-CommandBarItem-link[aria-label*="Download"]',
                                        '[data-icon-name="Download"]'
                                    ];
                                    
                                    for (const selector of downloadButtons) {
                                        const button = document.querySelector(selector);
                                        if (button && !button.disabled && !button.hidden) {
                                            console.log(`Found download button: ${selector}`);
                                            button.click();
                                            resolve({ success: true, button: selector });
                                            return;
                                        }
                                    }
                                    
                                    // If no specific download button, look for any button with "download" text
                                    const allButtons = document.querySelectorAll('button, a, [role="button"]');
                                    for (const button of allButtons) {
                                        const text = button.textContent || button.getAttribute('aria-label') || button.getAttribute('title') || '';
                                        if (text.toLowerCase().includes('download')) {
                                            console.log(`Found generic download button: ${text}`);
                                            button.click();
                                            resolve({ success: true, button: 'generic', text: text });
                                            return;
                                        }
                                    }
                                    
                                    resolve({ success: false, reason: 'No download button found' });
                                }, 1000);
                            } catch (error) {
                                resolve({ success: false, reason: error.message });
                            }
                        }, 2000);
                    });
                });
                
                if (zipDownloadResult.success) {
                    console.log(chalk.green(`✅ Download button clicked: ${zipDownloadResult.button}`));
                    
                    try {
                        // Wait for ZIP download (folder downloads usually create a ZIP)
                        console.log(chalk.blue('⏳ Waiting for folder download to complete...'));
                        const downloadedFile = await this.waitForDownload(downloadPath, 'Grounding.zip', 120000); // 2 minute timeout
                        
                        return {
                            isFolder: true,
                            isFolderZip: true,
                            files: [{ name: downloadedFile, downloadPath: downloadPath }],
                            downloadPath: downloadPath,
                            extractedBy: 'browser-download'
                        };
                        
                    } catch (downloadError) {
                        console.log(chalk.yellow(`⚠️  ZIP download failed: ${downloadError.message}`));
                        // Continue to fallback
                    }
                } else {
                    console.log(chalk.yellow(`⚠️  Could not find download button: ${zipDownloadResult.reason}`));
                }
                
                // If ZIP download failed, return empty result to trigger direct extraction fallback
                throw new Error('Browser folder download failed')
                
                return {
                    isFolder: true,
                    files: downloadedFiles,
                    downloadPath: downloadPath,
                    extractedBy: 'browser-download'
                };
            }
            
            // Single file download
            console.log(chalk.blue('📄 Single file detected, downloading...'));
            
            // Try to click download button for single file
            const downloadClicked = await page.evaluate(() => {
                const downloadSelectors = [
                    'button[data-automation-id="downloadCommand"]',
                    '[data-automation-id="downloadButton"]',
                    'button[aria-label*="Download"]',
                    'button[title*="Download"]',
                    '.ms-CommandBarItem-link[aria-label*="Download"]'
                ];
                
                for (const selector of downloadSelectors) {
                    const button = document.querySelector(selector);
                    if (button && !button.disabled) {
                        button.click();
                        return true;
                    }
                }
                return false;
            });
            
            if (!downloadClicked) {
                throw new Error('Could not find download button');
            }
            
            // Get filename
            const filename = await page.evaluate(() => {
                const nameSelectors = [
                    '[data-automation-id="fieldRendererFileName"] span',
                    'h1[data-automation-id="contentHeader"]',
                    '.od-ItemName',
                    'title'
                ];
                
                for (const selector of nameSelectors) {
                    const element = document.querySelector(selector);
                    if (element && element.textContent) {
                        return element.textContent.trim();
                    }
                }
                
                return 'onedrive_file';
            });
            
            // Wait for download
            await this.waitForDownload(downloadPath, filename, 30000);
            
            return {
                name: filename,
                downloadPath: downloadPath,
                extractedBy: 'browser-download'
            };
            
        } finally {
            await browser.close();
        }
    }
    
    async waitForDownload(downloadPath, expectedFilename, timeout = 30000) {
        console.log(chalk.blue(`⏳ Waiting for download to complete: ${expectedFilename}`));
        
        const startTime = Date.now();
        
        while (Date.now() - startTime < timeout) {
            try {
                const files = await fs.readdir(downloadPath);
                
                // Look for the expected file or any file if filename is generic
                const downloadedFile = files.find(file => 
                    file === expectedFilename || 
                    file.includes(expectedFilename.split('.')[0]) ||
                    (expectedFilename === 'onedrive_file' && file !== '.crdownload')
                );
                
                if (downloadedFile && !downloadedFile.endsWith('.crdownload')) {
                    console.log(chalk.green(`✅ Download completed: ${downloadedFile}`));
                    return downloadedFile;
                }
                
            } catch (error) {
                // Directory might not exist yet
            }
            
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        throw new Error(`Download timeout for ${expectedFilename}`);
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
        
        // Extract more URL components
        const urlObj = new URL(finalUrl);
        const rawFileId = urlObj.searchParams.get('id');
        const cid = urlObj.searchParams.get('cid');
        
        if (fileId) {
            // Microsoft Graph API endpoints
            downloadUrls.push(`https://api.onedrive.com/v1.0/shares/s!${fileId}/root/content`);
            downloadUrls.push(`https://graph.microsoft.com/v1.0/shares/s!${fileId}/driveItem/content`);
        }
        
        // OneDrive direct download patterns
        if (cid && rawFileId) {
            downloadUrls.push(`https://onedrive.live.com/download?cid=${cid}&id=${rawFileId}`);
            downloadUrls.push(`https://onedrive.live.com/download?cid=${cid}&id=${rawFileId}&authkey=anonymous`);
            downloadUrls.push(`https://onedrive.live.com/redir?cid=${cid}&id=${rawFileId}&authkey=download`);
        }
        
        // Original URL with download parameter
        downloadUrls.push(finalUrl + (finalUrl.includes('?') ? '&' : '?') + 'download=1');
        downloadUrls.push(finalUrl.replace(/[?&]sb=[^&]*/, '').replace(/[?&]sd=[^&]*/, '') + '&download=1');
        
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
        // Handle browser downloads
        if (fileInfo.extractedBy === 'browser-download') {
            console.log(chalk.blue(`📁 Moving browser download: ${fileInfo.name}`));
            
            const downloadPath = fileInfo.downloadPath;
            const files = await fs.readdir(downloadPath);
            
            // Find the downloaded file
            const downloadedFile = files.find(file => 
                file === fileInfo.name || 
                file.includes(fileInfo.name.split('.')[0]) ||
                (!file.includes('.crdownload') && files.length === 1)
            );
            
            if (!downloadedFile) {
                throw new Error(`Downloaded file not found in ${downloadPath}`);
            }
            
            const sourcePath = path.join(downloadPath, downloadedFile);
            const targetPath = path.join(tempDir, fileInfo.name || downloadedFile);
            
            // Move file to temp directory
            await fs.move(sourcePath, targetPath);
            console.log(chalk.green(`✅ Moved: ${downloadedFile} -> ${targetPath}`));
            
            return targetPath;
        }
        
        // Original axios-based download logic for fallback
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
            
            // Single file processing
            const tempDir = await fs.mkdtemp(path.join(require('os').tmpdir(), 'onedrive-'));
            
            try {
                const filePath = await this.downloadFile(extractedInfo, tempDir);
                const r2Key = r2Prefix ? `${r2Prefix}/${extractedInfo.name}` : extractedInfo.name;
                await this.uploadToR2(filePath, r2Key);
                
                console.log(chalk.green(`🎉 Success: ${extractedInfo.name}`));
                
                // Clean up download directory for browser downloads
                if (extractedInfo.extractedBy === 'browser-download' && extractedInfo.downloadPath) {
                    try {
                        await fs.remove(extractedInfo.downloadPath);
                        console.log(chalk.gray(`🗑️  Cleaned up download directory`));
                    } catch (error) {
                        console.log(chalk.yellow(`⚠️  Could not clean up download directory: ${error.message}`));
                    }
                }
                
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
        
        // For browser downloads, files are already downloaded
        if (folderInfo.extractedBy === 'browser-download') {
            for (const [index, file] of folderInfo.files.entries()) {
                console.log(chalk.blue(`\n📄 Processing file ${index + 1}/${folderInfo.files.length}: ${file.name}`));
                
                const tempDir = await fs.mkdtemp(path.join(require('os').tmpdir(), 'onedrive-'));
                
                try {
                    // File info for browser downloads
                    const fileInfo = {
                        name: file.name,
                        downloadPath: file.downloadPath,
                        extractedBy: 'browser-download'
                    };
                    
                    const filePath = await this.downloadFile(fileInfo, tempDir);
                    const r2Key = r2Prefix ? `${r2Prefix}/${file.name}` : file.name;
                    await this.uploadToR2(filePath, r2Key);
                    
                    console.log(chalk.green(`✅ Success: ${file.name}`));
                    successCount++;
                    
                } catch (error) {
                    console.error(chalk.red(`❌ Failed ${file.name}: ${error.message}`));
                    failCount++;
                } finally {
                    await fs.remove(tempDir);
                }
            }
            
            // Clean up download directory
            try {
                await fs.remove(folderInfo.downloadPath);
                console.log(chalk.gray(`🗑️  Cleaned up download directory`));
            } catch (error) {
                console.log(chalk.yellow(`⚠️  Could not clean up download directory: ${error.message}`));
            }
            
        } else {
            // Original logic for URL-based downloads
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