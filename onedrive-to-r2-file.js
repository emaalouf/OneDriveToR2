#!/usr/bin/env node

const fs = require('fs-extra');
const path = require('path');
const puppeteer = require('puppeteer');
const { S3Client } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { program } = require('commander');
const chalk = require('chalk');
require('dotenv').config();

class OneDriveFileToR2 {
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
        
        console.log(chalk.green('✅ OneDrive File to R2 initialized'));
    }
    
    validateConfig() {
        const required = ['R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME'];
        const missing = required.filter(key => !process.env[key]);
        
        if (missing.length > 0) {
            console.error(chalk.red(`❌ Missing environment variables: ${missing.join(', ')}`));
            process.exit(1);
        }
        
        if (process.env.ONEDRIVE_EMAIL && process.env.ONEDRIVE_PASSWORD) {
            console.log(chalk.green('🔐 OneDrive authentication credentials found'));
        }
    }
    
    async authenticateIfNeeded(page) {
        const currentUrl = page.url();
        if (currentUrl.includes('login.live.com') || currentUrl.includes('login.microsoftonline.com')) {
            const email = process.env.ONEDRIVE_EMAIL;
            const password = process.env.ONEDRIVE_PASSWORD;
            
            if (!email || !password) {
                throw new Error('Authentication required but ONEDRIVE_EMAIL or ONEDRIVE_PASSWORD not provided.');
            }
            
            console.log(chalk.blue(`🔑 Logging in with email: ${email.substring(0, 3)}***${email.substring(email.lastIndexOf('@'))}`));
            
            await page.waitForSelector('input[type="email"], input[name="loginfmt"], #i0116', { timeout: 10000 });
            await page.type('input[type="email"], input[name="loginfmt"], #i0116', email);
            await page.click('#idSIButton9, input[type="submit"], button[type="submit"]');
            
            await page.waitForSelector('input[type="password"], input[name="passwd"], #i0118', { timeout: 10000 });
            await page.type('input[type="password"], input[name="passwd"], #i0118', password);
            await page.click('#idSIButton9, input[type="submit"], button[type="submit"]');
            
            try {
                await page.waitForSelector('#idSIButton9', { timeout: 5000 });
                const buttonText = await page.$eval('#idSIButton9', el => el.textContent);
                if (buttonText && buttonText.toLowerCase().includes('yes')) {
                    await page.click('#idSIButton9');
                }
            } catch (error) {
                // No stay signed in prompt
            }
            
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
            console.log(chalk.green('✅ Successfully authenticated!'));
        }
    }
    
    async downloadFile(url) {
        console.log(chalk.blue(`📁 Downloading file from: ${url}`));
        
        const downloadPath = path.join(require('os').tmpdir(), 'onedrive-file-' + Date.now());
        await fs.ensureDir(downloadPath);
        
        const browser = await puppeteer.launch({
            headless: process.env.PUPPETEER_HEADLESS !== 'false',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        
        try {
            const page = await browser.newPage();
            
            const client = await page.target().createCDPSession();
            await client.send('Page.setDownloadBehavior', {
                behavior: 'allow',
                downloadPath: downloadPath
            });
            
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
            await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
            
            await this.authenticateIfNeeded(page);
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            // Get filename
            const filename = await page.evaluate(() => {
                const selectors = [
                    '[data-automation-id="fieldRendererFileName"] span',
                    'h1[data-automation-id="contentHeader"]',
                    '.od-ItemName',
                    'title'
                ];
                
                for (const selector of selectors) {
                    const element = document.querySelector(selector);
                    if (element && element.textContent) {
                        return element.textContent.trim();
                    }
                }
                
                // Extract from URL if no element found
                const pathParts = window.location.pathname.split('/');
                return pathParts[pathParts.length - 1] || 'onedrive_file';
            });
            
            console.log(chalk.blue(`📄 File detected: ${filename}`));
            
            // Click download button
            const downloadClicked = await page.evaluate(() => {
                const selectors = [
                    '[data-automationid="splitbuttonprimary"]',
                    'i[data-icon-name="download"]',
                    'button[data-automation-id="downloadCommand"]',
                    'button[aria-label*="Download"]',
                    'button[title*="Download"]'
                ];
                
                for (const selector of selectors) {
                    const element = document.querySelector(selector);
                    if (element) {
                        let clickTarget = element;
                        
                        // Find clickable parent if needed
                        if (element.tagName !== 'BUTTON' && element.getAttribute('role') !== 'button') {
                            let parent = element.parentElement;
                            while (parent && parent !== document.body) {
                                if (parent.tagName === 'BUTTON' || 
                                    parent.getAttribute('role') === 'button' ||
                                    parent.classList.contains('ms-Button')) {
                                    clickTarget = parent;
                                    break;
                                }
                                parent = parent.parentElement;
                            }
                        }
                        
                        if (clickTarget && !clickTarget.disabled) {
                            clickTarget.click();
                            return true;
                        }
                    }
                }
                return false;
            });
            
            if (!downloadClicked) {
                throw new Error('Could not find download button');
            }
            
            console.log(chalk.green('✅ Download initiated, waiting for completion...'));
            
            // Wait for download (increased timeout for large files)
            const downloadedFile = await this.waitForDownload(downloadPath, 7200000); // 2 hours
            
            return {
                filePath: path.join(downloadPath, downloadedFile),
                fileName: downloadedFile,
                originalName: filename,
                downloadPath: downloadPath
            };
            
        } finally {
            await browser.close();
        }
    }
    
    async waitForDownload(downloadPath, timeout = 7200000) { // Default 2 hours for large files
        const startTime = Date.now();
        let lastSize = 0;
        let stableCount = 0;
        let lastProgressTime = 0;
        
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
                    const elapsed = (Date.now() - startTime) / 1000;
                    
                    // Show progress every 10 seconds
                    if (Date.now() - lastProgressTime > 10000) {
                        const speed = elapsed > 0 ? this.formatBytes(currentSize / elapsed) + '/s' : '0 B/s';
                        const remainingTime = Math.floor((timeout - (Date.now() - startTime)) / 1000);
                        
                        console.log(chalk.gray(
                            `📥 Downloading: ${this.formatBytes(currentSize)} | ` +
                            `Speed: ${speed} | ` +
                            `Elapsed: ${Math.floor(elapsed)}s | ` +
                            `Timeout in: ${remainingTime}s`
                        ));
                        lastProgressTime = Date.now();
                    }
                    
                    // Check if download has stalled (size hasn't changed)
                    if (currentSize === lastSize) {
                        stableCount++;
                    } else {
                        stableCount = 0;
                    }
                    lastSize = currentSize;
                    
                    // If size stable for too long and file is reasonably sized, might be complete
                    if (stableCount > 30 && currentSize > 1024 * 1024) { // 30 seconds stable and > 1MB
                        console.log(chalk.yellow('⚠️  Download appears complete but file still has .crdownload extension'));
                        console.log(chalk.gray('🔄 Waiting for browser to finalize...'));
                    }
                } else {
                    // No files yet, show waiting message every 30 seconds
                    const elapsed = Math.floor((Date.now() - startTime) / 1000);
                    if (elapsed % 30 === 0 && elapsed > 0) {
                        console.log(chalk.gray(`⏳ Waiting for download to start... (${elapsed}s elapsed)`));
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
        
        throw new Error(`Download timeout after ${Math.floor(timeout / 1000 / 60)} minutes`);
    }
    
    async uploadToR2(filePath, r2Key) {
        console.log(chalk.blue(`☁️  Uploading: ${r2Key}`));
        
        const fileStream = fs.createReadStream(filePath);
        const fileStats = await fs.stat(filePath);
        
        console.log(chalk.gray(`📊 Size: ${this.formatBytes(fileStats.size)}`));
        
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
    
    async processFile(url, r2Prefix = '') {
        try {
            const downloadResult = await this.downloadFile(url);
            
            const r2Key = r2Prefix ? 
                `${r2Prefix}/${downloadResult.fileName}` : 
                downloadResult.fileName;
                
            await this.uploadToR2(downloadResult.filePath, r2Key);
            
            // Cleanup
            await fs.remove(downloadResult.downloadPath);
            console.log(chalk.gray('🗑️  Cleaned up temporary files'));
            
            console.log(chalk.green(`🎉 Success: ${downloadResult.originalName}`));
            return { success: true, filename: downloadResult.originalName, r2Key };
            
        } catch (error) {
            console.error(chalk.red(`❌ Failed: ${error.message}`));
            return { success: false, error: error.message, url };
        }
    }
    
    async processUrlsFromFile(filePath, r2Prefix = '') {
        console.log(chalk.blue(`📄 Reading URLs from: ${filePath}`));
        
        try {
            const fileContent = await fs.readFile(filePath, 'utf8');
            const urls = fileContent
                .split('\n')
                .map(line => line.trim())
                .filter(line => line && !line.startsWith('#') && !line.startsWith('//'));
            
            if (urls.length === 0) {
                throw new Error('No valid URLs found in file');
            }
            
            console.log(chalk.blue(`📋 Found ${urls.length} URLs to process`));
            console.log(chalk.gray('💡 Lines starting with # or // are treated as comments and ignored\n'));
            
            const results = {
                total: urls.length,
                successful: [],
                failed: [],
                startTime: Date.now()
            };
            
            for (let i = 0; i < urls.length; i++) {
                const url = urls[i];
                const progress = `[${i + 1}/${urls.length}]`;
                
                console.log(chalk.blue(`\n${progress} Processing: ${url}`));
                
                const result = await this.processFile(url, r2Prefix);
                
                if (result.success) {
                    results.successful.push({
                        url,
                        filename: result.filename,
                        r2Key: result.r2Key
                    });
                    console.log(chalk.green(`${progress} ✅ Success`));
                } else {
                    results.failed.push({
                        url,
                        error: result.error
                    });
                    console.log(chalk.red(`${progress} ❌ Failed: ${result.error}`));
                }
                
                // Add a small delay between files to be respectful to OneDrive
                if (i < urls.length - 1) {
                    console.log(chalk.gray('⏳ Waiting 2 seconds before next file...'));
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }
            
            const duration = ((Date.now() - results.startTime) / 1000).toFixed(1);
            
            console.log(chalk.blue('\n📊 BATCH PROCESSING SUMMARY'));
            console.log(chalk.blue('=' .repeat(50)));
            console.log(chalk.gray(`⏱️  Total time: ${duration} seconds`));
            console.log(chalk.gray(`📁 R2 Prefix: ${r2Prefix || '(root)'}`));
            console.log(chalk.green(`✅ Successful: ${results.successful.length}`));
            console.log(chalk.red(`❌ Failed: ${results.failed.length}`));
            
            if (results.successful.length > 0) {
                console.log(chalk.green('\n🎉 Successfully processed files:'));
                results.successful.forEach((item, index) => {
                    console.log(chalk.green(`  ${index + 1}. ${item.filename} → ${item.r2Key}`));
                });
            }
            
            if (results.failed.length > 0) {
                console.log(chalk.red('\n💥 Failed files:'));
                results.failed.forEach((item, index) => {
                    console.log(chalk.red(`  ${index + 1}. ${item.url}`));
                    console.log(chalk.gray(`     Error: ${item.error}`));
                });
            }
            
            console.log(chalk.blue('=' .repeat(50)));
            
            return results.successful.length > 0;
            
        } catch (error) {
            console.error(chalk.red(`❌ Failed to process file: ${error.message}`));
            return false;
        }
    }
}

program
    .name('onedrive-to-r2-file')
    .description('Download individual OneDrive file(s) to Cloudflare R2')
    .version('1.0.0')
    .argument('[url]', 'OneDrive file URL (optional if using --file)')
    .option('-p, --prefix <prefix>', 'R2 prefix')
    .option('-f, --file <path>', 'Text file containing OneDrive URLs (one per line)')
    .option('-e, --email <email>', 'OneDrive email address')
    .option('-w, --password <password>', 'OneDrive password')
    .action(async (url, options) => {
        if (!url && !options.file) {
            console.error(chalk.red('❌ Please provide either a URL or a file with URLs'));
            console.log(chalk.yellow('💡 Single file: node onedrive-to-r2-file.js "https://1drv.ms/v/c/..." --prefix "videos"'));
            console.log(chalk.yellow('💡 Batch mode: node onedrive-to-r2-file.js --file "urls.txt" --prefix "videos"'));
            console.log(chalk.yellow('💡 With auth: node onedrive-to-r2-file.js --file "urls.txt" --email "your@email.com" --password "password"'));
            return;
        }
        
        if (url && options.file) {
            console.error(chalk.red('❌ Please provide either a URL or a file, not both'));
            return;
        }
        
        if (options.email) process.env.ONEDRIVE_EMAIL = options.email;
        if (options.password) process.env.ONEDRIVE_PASSWORD = options.password;
        
        const downloader = new OneDriveFileToR2();
        let success;
        
        if (options.file) {
            // Batch processing from file
            console.log(chalk.blue('🚀 Starting OneDrive Batch File to R2 transfer...'));
            console.log(chalk.gray(`📄 File: ${options.file}`));
            if (options.prefix) {
                console.log(chalk.gray(`📁 R2 Prefix: ${options.prefix}`));
            }
            if (process.env.ONEDRIVE_EMAIL) {
                console.log(chalk.gray(`🔐 Authentication: ${process.env.ONEDRIVE_EMAIL.substring(0, 3)}***${process.env.ONEDRIVE_EMAIL.substring(process.env.ONEDRIVE_EMAIL.lastIndexOf('@'))}`));
            }
            
            success = await downloader.processUrlsFromFile(options.file, options.prefix);
        } else {
            // Single file processing
            console.log(chalk.blue('🚀 Starting OneDrive File to R2 transfer...'));
            console.log(chalk.gray(`📎 URL: ${url}`));
            if (options.prefix) {
                console.log(chalk.gray(`📁 R2 Prefix: ${options.prefix}`));
            }
            if (process.env.ONEDRIVE_EMAIL) {
                console.log(chalk.gray(`🔐 Authentication: ${process.env.ONEDRIVE_EMAIL.substring(0, 3)}***${process.env.ONEDRIVE_EMAIL.substring(process.env.ONEDRIVE_EMAIL.lastIndexOf('@'))}`));
            }
            
            const result = await downloader.processFile(url, options.prefix);
            success = result.success;
        }
        
        if (success) {
            console.log(chalk.green('\n🎉 Transfer completed successfully!'));
        } else {
            console.log(chalk.red('\n💥 Transfer failed. Check the logs above for details.'));
            process.exit(1);
        }
    });

program.parse(); 