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
            
            // Wait for download
            const downloadedFile = await this.waitForDownload(downloadPath, 60000);
            
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
    
    async waitForDownload(downloadPath, timeout = 60000) {
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
            return true;
            
        } catch (error) {
            console.error(chalk.red(`❌ Failed: ${error.message}`));
            return false;
        }
    }
}

program
    .name('onedrive-to-r2-file')
    .description('Download individual OneDrive file to Cloudflare R2')
    .version('1.0.0')
    .argument('[url]', 'OneDrive file URL')
    .option('-p, --prefix <prefix>', 'R2 prefix')
    .option('-e, --email <email>', 'OneDrive email address')
    .option('-w, --password <password>', 'OneDrive password')
    .action(async (url, options) => {
        if (!url) {
            console.error(chalk.red('❌ Please provide a OneDrive file URL'));
            console.log(chalk.yellow('💡 Example: node onedrive-to-r2-file.js "https://1drv.ms/v/c/..." --prefix "videos"'));
            return;
        }
        
        if (options.email) process.env.ONEDRIVE_EMAIL = options.email;
        if (options.password) process.env.ONEDRIVE_PASSWORD = options.password;
        
        console.log(chalk.blue('🚀 Starting OneDrive File to R2 transfer...'));
        console.log(chalk.gray(`📎 URL: ${url}`));
        if (options.prefix) {
            console.log(chalk.gray(`📁 R2 Prefix: ${options.prefix}`));
        }
        
        const downloader = new OneDriveFileToR2();
        const success = await downloader.processFile(url, options.prefix);
        
        if (success) {
            console.log(chalk.green('\n🎉 Transfer completed successfully!'));
        } else {
            console.log(chalk.red('\n💥 Transfer failed. Check the logs above for details.'));
            process.exit(1);
        }
    });

program.parse(); 