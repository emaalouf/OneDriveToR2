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
            
            // Set download path
            const client = await page.target().createCDPSession();
            await client.send('Page.setDownloadBehavior', {
                behavior: 'allow',
                downloadPath: downloadPath
            });
            
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
            await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
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
                            console.log('=== DEBUGGING: Searching for download buttons ===');
                            console.log('Page title:', document.title);
                            console.log('Current URL:', window.location.href);
                            
                            // First, let's see ALL buttons on the page
                            const allButtons = document.querySelectorAll('button, a, [role="button"], .ms-CommandBarItem, [data-automation-id*="Command"]');
                            console.log(`Found ${allButtons.length} total interactive elements`);
                            
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
                            
                            console.log('Button details:', JSON.stringify(buttonInfo, null, 2));
                            
                            // Try different download button selectors
                            const selectors = [
                                'button[data-automation-id="downloadCommand"]',
                                '[data-automation-id="downloadButton"]',
                                'button[aria-label*="Download"]',
                                'button[title*="Download"]',
                                '.ms-CommandBarItem-link[aria-label*="Download"]',
                                '[data-icon-name="Download"]',
                                '[data-automation-id*="download"]',
                                '.ms-CommandBarItem[aria-label*="Download"]'
                            ];
                            
                            for (const selector of selectors) {
                                const button = document.querySelector(selector);
                                if (button && !button.disabled) {
                                    console.log(`Found download button: ${selector}`);
                                    button.click();
                                    resolve({ success: true, selector });
                                    return;
                                }
                            }
                            
                            // Try to select all files first, then look for download
                            console.log('Trying to select all files first...');
                            const selectAllSelectors = [
                                '[data-automation-id="selectAllCommand"]',
                                'button[aria-label*="Select all"]',
                                'button[title*="Select all"]'
                            ];
                            
                            let selectAllClicked = false;
                            for (const selector of selectAllSelectors) {
                                const button = document.querySelector(selector);
                                if (button && !button.disabled) {
                                    console.log(`Found select all button: ${selector}`);
                                    button.click();
                                    selectAllClicked = true;
                                    break;
                                }
                            }
                            
                            if (selectAllClicked) {
                                // Wait a moment then try download again
                                setTimeout(() => {
                                    for (const selector of selectors) {
                                        const button = document.querySelector(selector);
                                        if (button && !button.disabled) {
                                            console.log(`Found download button after select all: ${selector}`);
                                            button.click();
                                            resolve({ success: true, selector: selector + ' (after select all)' });
                                            return;
                                        }
                                    }
                                    
                                    // Last resort: look for any button with "download" text
                                    for (const button of allButtons) {
                                        const text = (button.textContent || '').toLowerCase();
                                        const ariaLabel = (button.getAttribute('aria-label') || '').toLowerCase();
                                        
                                        if ((text.includes('download') || ariaLabel.includes('download')) && !button.disabled) {
                                            console.log(`Found generic download button: ${text || ariaLabel}`);
                                            button.click();
                                            resolve({ success: true, selector: 'generic', text: text || ariaLabel });
                                            return;
                                        }
                                    }
                                    
                                    resolve({ success: false, reason: 'No download button found even after select all', buttonCount: allButtons.length });
                                }, 2000);
                            } else {
                                resolve({ success: false, reason: 'No download or select all button found', buttonCount: allButtons.length });
                            }
                        } catch (error) {
                            resolve({ success: false, reason: error.message });
                        }
                    }, 3000);
                });
            });
            
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
    
    async waitForDownload(downloadPath, timeout = 120000) {
        const startTime = Date.now();
        
        while (Date.now() - startTime < timeout) {
            try {
                const files = await fs.readdir(downloadPath);
                const downloadedFiles = files.filter(file => 
                    !file.endsWith('.crdownload') && 
                    !file.includes('debug') &&
                    file.length > 0
                );
                
                if (downloadedFiles.length > 0) {
                    const file = downloadedFiles[0];
                    console.log(chalk.green(`✅ Download completed: ${file}`));
                    return file;
                }
                
            } catch (error) {
                // Directory might not exist yet
            }
            
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        throw new Error('Download timeout');
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
    .action(async (url, options) => {
        if (!url) {
            console.error(chalk.red('❌ Please provide a URL'));
            console.log(chalk.yellow('💡 Example: node onedrive-to-r2-simple.js "https://onedrive.live.com/...folder-url..." --prefix "videos/2024"'));
            return;
        }
        
        console.log(chalk.blue('🚀 Starting OneDrive Folder to R2 ZIP transfer...'));
        console.log(chalk.gray(`📎 URL: ${url}`));
        if (options.prefix) {
            console.log(chalk.gray(`📁 R2 Prefix: ${options.prefix}`));
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