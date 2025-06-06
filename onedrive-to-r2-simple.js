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

class OneDriveToR2Simple {
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
        
        console.log(chalk.green('✅ OneDrive to R2 Simple initialized'));
    }
    
    validateConfig() {
        const required = ['R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME'];
        const missing = required.filter(key => !process.env[key]);
        
        if (missing.length > 0) {
            console.error(chalk.red(`❌ Missing environment variables: ${missing.join(', ')}`));
            process.exit(1);
        }
        
        // Check for authentication credentials
        if (process.env.ONEDRIVE_EMAIL && process.env.ONEDRIVE_PASSWORD) {
            console.log(chalk.green('🔐 OneDrive authentication credentials found'));
        } else {
            console.log(chalk.yellow('⚠️  No OneDrive authentication credentials provided. Will attempt anonymous access.'));
            console.log(chalk.gray('💡 Set ONEDRIVE_EMAIL and ONEDRIVE_PASSWORD environment variables for authenticated access.'));
        }
    }
    
    async authenticateIfNeeded(page) {
        console.log(chalk.blue('🔐 Checking if authentication is required...'));
        
        const currentUrl = page.url();
        if (currentUrl.includes('login.live.com') || currentUrl.includes('login.microsoftonline.com')) {
            const email = process.env.ONEDRIVE_EMAIL;
            const password = process.env.ONEDRIVE_PASSWORD;
            
            if (!email || !password) {
                throw new Error('Authentication required but ONEDRIVE_EMAIL or ONEDRIVE_PASSWORD not provided. Please set these environment variables.');
            }
            
            console.log(chalk.blue(`🔑 Logging in with email: ${email.substring(0, 3)}***${email.substring(email.lastIndexOf('@'))}`));
            
            try {
                // Wait for email input and enter email
                await page.waitForSelector('input[type="email"], input[name="loginfmt"], #i0116', { timeout: 10000 });
                await page.type('input[type="email"], input[name="loginfmt"], #i0116', email);
                
                // Click next button
                await page.click('#idSIButton9, input[type="submit"], button[type="submit"]');
                
                // Wait for password input
                await page.waitForSelector('input[type="password"], input[name="passwd"], #i0118', { timeout: 10000 });
                await page.type('input[type="password"], input[name="passwd"], #i0118', password);
                
                // Click sign in button
                await page.click('#idSIButton9, input[type="submit"], button[type="submit"]');
                
                // Wait for potential "Stay signed in?" prompt and handle it
                try {
                    await page.waitForSelector('#idSIButton9', { timeout: 5000 });
                    // Check if it's the "Stay signed in?" prompt
                    const buttonText = await page.$eval('#idSIButton9', el => el.textContent);
                    if (buttonText && buttonText.toLowerCase().includes('yes')) {
                        console.log(chalk.gray('📝 Accepting "Stay signed in?" prompt'));
                        await page.click('#idSIButton9');
                    }
                } catch (error) {
                    // No stay signed in prompt, continue
                }
                
                // Wait for navigation to complete
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
                
                const finalUrl = page.url();
                if (finalUrl.includes('login.live.com') || finalUrl.includes('login.microsoftonline.com')) {
                    throw new Error('Authentication failed - still on login page. Please check your credentials.');
                }
                
                console.log(chalk.green('✅ Successfully authenticated!'));
                
            } catch (error) {
                console.error(chalk.red(`❌ Authentication failed: ${error.message}`));
                throw error;
            }
        } else {
            console.log(chalk.green('✅ No authentication required'));
        }
    }
    
    async downloadFolderAsZip(url) {
        console.log(chalk.blue('🌐 Using Puppeteer to download folder as ZIP...'));
        
        const downloadPath = path.join(require('os').tmpdir(), 'onedrive-simple-' + Date.now());
        await fs.ensureDir(downloadPath);
        
        const browser = await puppeteer.launch({
            headless: process.env.PUPPETEER_HEADLESS !== 'false',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-extensions',
                '--no-first-run'
            ],
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
            devtools: process.env.PUPPETEER_HEADLESS === 'false' // Open devtools when not headless
        });
        
        try {
            const page = await browser.newPage();
            
            // Capture browser console output
            page.on('console', msg => {
                console.log(chalk.gray(`[Browser Console] ${msg.type()}: ${msg.text()}`));
            });
            
            // Set download path
            const client = await page.target().createCDPSession();
            await client.send('Page.setDownloadBehavior', {
                behavior: 'allow',
                downloadPath: downloadPath
            });
            
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
            await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
            
            // Handle authentication if needed
            await this.authenticateIfNeeded(page);
            
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            // Take screenshot for debugging
            try {
                await page.screenshot({ path: path.join(downloadPath, 'debug-screenshot.png') });
                console.log(chalk.gray(`📷 Debug screenshot saved`));
            } catch (e) {}
            
            console.log(chalk.blue('🔍 Looking for download button...'));
            
            const downloadResult = await page.evaluate(() => {
                return new Promise((resolve) => {
                    setTimeout(() => {
                        try {
                            const debugInfo = {
                                title: document.title,
                                url: window.location.href,
                                allButtons: [],
                                attempts: []
                            };
                            
                            // First, let's see ALL buttons on the page
                            const allButtons = document.querySelectorAll('button, a, [role="button"], .ms-CommandBarItem, [data-automation-id*="Command"]');
                            debugInfo.totalButtons = allButtons.length;
                            
                            const buttonInfo = [];
                            for (let i = 0; i < Math.min(allButtons.length, 20); i++) {
                                const btn = allButtons[i];
                                buttonInfo.push({
                                    tag: btn.tagName,
                                    text: (btn.textContent || '').substring(0, 50),
                                    ariaLabel: btn.getAttribute('aria-label') || '',
                                    title: btn.getAttribute('title') || '',
                                    dataAutomationId: btn.getAttribute('data-automation-id') || '',
                                    className: btn.className || '',
                                    disabled: btn.disabled
                                });
                            }
                            
                            debugInfo.allButtons = buttonInfo;
                            
                            // Try different download button selectors
                            const selectors = [
                                '[data-automationid="splitbuttonprimary"]', // Main download button
                                'span[data-automationid="splitbuttonprimary"]', // Span variant
                                '.ms-Button-flexContainer[data-automationid="splitbuttonprimary"]', // Flex container
                                'i[data-icon-name="download"]', // Download icon
                                '[data-icon-name="download"]', // Any element with download icon
                                'button[data-automation-id="downloadCommand"]',
                                '[data-automation-id="downloadButton"]',
                                'button[aria-label*="Download"]',
                                'button[title*="Download"]',
                                '.ms-CommandBarItem-link[aria-label*="Download"]',
                                '[data-automation-id*="download"]',
                                '.ms-CommandBarItem[aria-label*="Download"]'
                            ];
                            
                            for (const selector of selectors) {
                                const element = document.querySelector(selector);
                                debugInfo.attempts.push({ selector, found: !!element, disabled: element?.disabled });
                                if (element) {
                                    // If we found the element, try to click it or find its clickable parent
                                    let clickTarget = element;
                                    
                                    // If it's not directly clickable, look for a clickable parent
                                    if (element.tagName !== 'BUTTON' && element.getAttribute('role') !== 'button') {
                                        // Look for parent button or clickable element
                                        let parent = element.parentElement;
                                        while (parent && parent !== document.body) {
                                            if (parent.tagName === 'BUTTON' || 
                                                parent.getAttribute('role') === 'button' ||
                                                parent.onclick ||
                                                parent.classList.contains('ms-Button') ||
                                                parent.classList.contains('ms-CommandBarItem')) {
                                                clickTarget = parent;
                                                break;
                                            }
                                            parent = parent.parentElement;
                                        }
                                    }
                                    
                                    if (clickTarget && !clickTarget.disabled) {
                                        clickTarget.click();
                                        resolve({ success: true, selector, clickedElement: clickTarget.tagName, debugInfo });
                                        return;
                                    }
                                }
                            }
                            
                            // Try to select all files first, then look for download
                            const selectAllSelectors = [
                                '[data-automation-id="selectAllCommand"]',
                                'button[aria-label*="Select all"]',
                                'button[title*="Select all"]'
                            ];
                            
                            let selectAllClicked = false;
                            for (const selector of selectAllSelectors) {
                                const button = document.querySelector(selector);
                                debugInfo.attempts.push({ type: 'selectAll', selector, found: !!button, disabled: button?.disabled });
                                if (button && !button.disabled) {
                                    button.click();
                                    selectAllClicked = true;
                                    debugInfo.selectAllClicked = selector;
                                    break;
                                }
                            }
                            
                            if (selectAllClicked) {
                                // Wait a moment then try download again
                                setTimeout(() => {
                                    for (const selector of selectors) {
                                        const button = document.querySelector(selector);
                                        debugInfo.attempts.push({ type: 'afterSelectAll', selector, found: !!button, disabled: button?.disabled });
                                        if (button && !button.disabled) {
                                            button.click();
                                            resolve({ success: true, selector: selector + ' (after select all)', debugInfo });
                                            return;
                                        }
                                    }
                                    
                                    // Last resort: look for any button with "download" text
                                    for (const button of allButtons) {
                                        const text = (button.textContent || '').toLowerCase();
                                        const ariaLabel = (button.getAttribute('aria-label') || '').toLowerCase();
                                        
                                        if ((text.includes('download') || ariaLabel.includes('download')) && !button.disabled) {
                                            button.click();
                                            resolve({ success: true, selector: 'generic', text: text || ariaLabel, debugInfo });
                                            return;
                                        }
                                    }
                                    
                                    resolve({ success: false, reason: 'No download button found even after select all', debugInfo });
                                }, 2000);
                            } else {
                                resolve({ success: false, reason: 'No download or select all button found', debugInfo });
                            }
                        } catch (error) {
                            resolve({ success: false, reason: error.message, debugInfo: { error: error.message } });
                        }
                    }, 3000);
                });
            });
            
            // Display debug information
            if (downloadResult.debugInfo) {
                console.log(chalk.blue('=== DEBUG INFORMATION ==='));
                console.log(chalk.gray(`Page Title: ${downloadResult.debugInfo.title}`));
                console.log(chalk.gray(`Page URL: ${downloadResult.debugInfo.url}`));
                console.log(chalk.gray(`Total Buttons Found: ${downloadResult.debugInfo.totalButtons}`));
                
                if (downloadResult.debugInfo.allButtons && downloadResult.debugInfo.allButtons.length > 0) {
                    console.log(chalk.gray('Available Buttons:'));
                    downloadResult.debugInfo.allButtons.forEach((btn, i) => {
                        console.log(chalk.gray(`  ${i + 1}. ${btn.tag} - "${btn.text}" (aria-label: "${btn.ariaLabel}", data-automation-id: "${btn.dataAutomationId}", disabled: ${btn.disabled})`));
                    });
                }
                
                if (downloadResult.debugInfo.attempts) {
                    console.log(chalk.gray('Button Search Attempts:'));
                    downloadResult.debugInfo.attempts.forEach((attempt, i) => {
                        console.log(chalk.gray(`  ${i + 1}. ${attempt.type || 'download'} - ${attempt.selector} - Found: ${attempt.found}, Disabled: ${attempt.disabled}`));
                    });
                }
                
                if (downloadResult.debugInfo.selectAllClicked) {
                    console.log(chalk.gray(`Select All Clicked: ${downloadResult.debugInfo.selectAllClicked}`));
                }
                console.log(chalk.blue('=== END DEBUG ==='));
            }
            
            if (!downloadResult.success) {
                throw new Error(`Could not find download button: ${downloadResult.reason}`);
            }
            
            console.log(chalk.green(`✅ Download button clicked: ${downloadResult.selector}`));
            console.log(chalk.blue('⏳ Waiting for download to complete...'));
            
            // Wait for download to complete
            const downloadedFile = await this.waitForDownload(downloadPath, 120000);
            
            return {
                filePath: path.join(downloadPath, downloadedFile),
                fileName: downloadedFile,
                downloadPath: downloadPath
            };
            
        } finally {
            await browser.close();
        }
    }
    
    async waitForDownload(downloadPath, timeout = 120000000) {
        const startTime = Date.now();
        let progressBar = null;
        let lastSize = 0;
        let stableCount = 0;
        let currentFile = null;
        
        console.log(chalk.blue('📊 Monitoring download progress...'));
        
        while (Date.now() - startTime < timeout) {
            try {
                const files = await fs.readdir(downloadPath);
                
                // Look for downloading files (.crdownload) and completed files
                const downloadingFiles = files.filter(file => file.endsWith('.crdownload'));
                const completedFiles = files.filter(file => 
                    !file.endsWith('.crdownload') && 
                    !file.includes('debug') &&
                    file.length > 0
                );
                
                if (completedFiles.length > 0) {
                    // Download completed
                    if (progressBar) {
                        progressBar.stop();
                        console.log(''); // New line after progress bar
                    }
                    const file = completedFiles[0];
                    const finalStats = await fs.stat(path.join(downloadPath, file));
                    console.log(chalk.green(`✅ Download completed: ${file} (${this.formatBytes(finalStats.size)})`));
                    return file;
                }
                
                if (downloadingFiles.length > 0) {
                    // Download in progress
                    const downloadingFile = downloadingFiles[0];
                    const filePath = path.join(downloadPath, downloadingFile);
                    const stats = await fs.stat(filePath);
                    const currentSize = stats.size;
                    
                    if (!progressBar && currentSize > 0) {
                        // Initialize progress bar
                        progressBar = new cliProgress.SingleBar({
                            format: 'Downloading |{bar}| {percentage}% | {value}/{total} | {speed} | ETA: {eta}s',
                            barCompleteChar: '█',
                            barIncompleteChar: '░',
                            hideCursor: true
                        });
                        
                        // Start with current size, we'll update total when we can estimate it
                        progressBar.start(currentSize * 2, currentSize); // Initial guess
                        currentFile = downloadingFile;
                        console.log(chalk.gray(`📁 Downloading: ${downloadingFile.replace('.crdownload', '')}`));
                    }
                    
                    if (progressBar) {
                        // Calculate download speed
                        const timeDiff = (Date.now() - startTime) / 1000;
                        const speed = timeDiff > 0 ? this.formatBytes(currentSize / timeDiff) + '/s' : '0 B/s';
                        
                        // Update progress bar
                        if (currentSize > progressBar.getTotal()) {
                            // File is larger than expected, increase total
                            progressBar.setTotal(currentSize * 1.5);
                        }
                        
                        progressBar.update(currentSize, {
                            speed: speed,
                            total: this.formatBytes(progressBar.getTotal()),
                            value: this.formatBytes(currentSize)
                        });
                        
                        // Check if download has stalled (size hasn't changed)
                        if (currentSize === lastSize) {
                            stableCount++;
                        } else {
                            stableCount = 0;
                        }
                        lastSize = currentSize;
                        
                        // If size stable for too long and file is reasonably sized, might be complete
                        if (stableCount > 5 && currentSize > 1024 * 1024) { // 1MB minimum and stable for 5 seconds
                            console.log(chalk.yellow('\n⚠️  Download appears complete but file still has .crdownload extension'));
                            console.log(chalk.gray('🔄 Waiting for browser to finalize...'));
                        }
                    }
                } else if (!progressBar) {
                    // No files yet, show waiting message
                    const elapsed = Math.floor((Date.now() - startTime) / 1000);
                    if (elapsed % 5 === 0 && elapsed > 0) { // Every 5 seconds
                        console.log(chalk.gray(`⏳ Waiting for download to start... (${elapsed}s)`));
                    }
                }
                
            } catch (error) {
                // Directory might not exist yet or file access error
                if (!error.message.includes('ENOENT')) {
                    console.log(chalk.yellow(`⚠️  File access error: ${error.message}`));
                }
            }
            
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        // Timeout occurred
        if (progressBar) {
            progressBar.stop();
            console.log(''); // New line after progress bar
        }
        throw new Error('Download timeout');
    }
    
    async uploadToR2(filePath, r2Key) {
        console.log(chalk.blue(`☁️  Uploading: ${r2Key}`));
        
        const fileStream = fs.createReadStream(filePath);
        const fileStats = await fs.stat(filePath);
        const totalSize = fileStats.size;
        
        console.log(chalk.gray(`📊 Size: ${this.formatBytes(totalSize)}`));
        
        // Create upload progress bar
        const uploadProgressBar = new cliProgress.SingleBar({
            format: 'Uploading |{bar}| {percentage}% | {value}/{total} | {speed} | ETA: {eta}s',
            barCompleteChar: '█',
            barIncompleteChar: '░',
            hideCursor: true
        });
        
        uploadProgressBar.start(totalSize, 0);
        
        const upload = new Upload({
            client: this.s3Client,
            params: {
                Bucket: this.bucketName,
                Key: r2Key,
                Body: fileStream
            }
        });
        
        // Track upload progress
        let uploadedBytes = 0;
        const startTime = Date.now();
        
        upload.on('httpUploadProgress', (progress) => {
            if (progress.loaded !== undefined) {
                uploadedBytes = progress.loaded;
                const elapsed = (Date.now() - startTime) / 1000;
                const speed = elapsed > 0 ? this.formatBytes(uploadedBytes / elapsed) + '/s' : '0 B/s';
                
                uploadProgressBar.update(uploadedBytes, {
                    speed: speed,
                    total: this.formatBytes(totalSize),
                    value: this.formatBytes(uploadedBytes)
                });
            }
        });
        
        try {
            await upload.done();
            uploadProgressBar.stop();
            console.log(''); // New line after progress bar
            console.log(chalk.green(`✅ Uploaded: ${r2Key} (${this.formatBytes(totalSize)})`));
        } catch (error) {
            uploadProgressBar.stop();
            console.log(''); // New line after progress bar
            throw error;
        }
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
            console.log(chalk.blue('📁 Attempting to download OneDrive folder as ZIP...'));
            
            const downloadResult = await this.downloadFolderAsZip(url);
            
            const r2Key = r2Prefix ? `${r2Prefix}/${downloadResult.fileName}` : downloadResult.fileName;
            await this.uploadToR2(downloadResult.filePath, r2Key);
            
            // Cleanup
            await fs.remove(downloadResult.downloadPath);
            console.log(chalk.gray('🗑️  Cleaned up temporary files'));
            
            console.log(chalk.green(`🎉 Success: ${downloadResult.fileName}`));
            return true;
            
        } catch (error) {
            console.error(chalk.red(`❌ Failed: ${error.message}`));
            return false;
        }
    }
}

program
    .name('onedrive-to-r2-simple')
    .description('Download OneDrive folder as ZIP to Cloudflare R2')
    .version('1.0.0')
    .argument('[url]', 'OneDrive folder URL')
    .option('-p, --prefix <prefix>', 'R2 prefix')
    .option('-e, --email <email>', 'OneDrive email address')
    .option('-w, --password <password>', 'OneDrive password')
    .action(async (url, options) => {
        if (!url) {
            console.error(chalk.red('❌ Please provide a URL'));
            console.log(chalk.yellow('💡 Example: node onedrive-to-r2-simple.js "https://onedrive.live.com/...folder-url..." --prefix "videos/2024"'));
            console.log(chalk.yellow('💡 With authentication: node onedrive-to-r2-simple.js "https://onedrive.live.com/..." --email "your@email.com" --password "yourpassword"'));
            return;
        }
        
        // Set authentication environment variables if provided via command line
        if (options.email) {
            process.env.ONEDRIVE_EMAIL = options.email;
        }
        if (options.password) {
            process.env.ONEDRIVE_PASSWORD = options.password;
        }
        
        console.log(chalk.blue('🚀 Starting OneDrive Folder to R2 ZIP transfer...'));
        console.log(chalk.gray(`📎 URL: ${url}`));
        if (options.prefix) {
            console.log(chalk.gray(`📁 R2 Prefix: ${options.prefix}`));
        }
        if (process.env.ONEDRIVE_EMAIL) {
            console.log(chalk.gray(`🔐 Authentication: ${process.env.ONEDRIVE_EMAIL.substring(0, 3)}***${process.env.ONEDRIVE_EMAIL.substring(process.env.ONEDRIVE_EMAIL.lastIndexOf('@'))}`));
        }
        
        const downloader = new OneDriveToR2Simple();
        const success = await downloader.processLink(url, options.prefix);
        
        if (success) {
            console.log(chalk.green('\n🎉 Transfer completed successfully!'));
        } else {
            console.log(chalk.red('\n💥 Transfer failed. Check the logs above for details.'));
            process.exit(1);
        }
    });

program.parse(); 