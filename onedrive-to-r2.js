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
                '--no-first-run'
            ]
        });
        
        try {
            const page = await browser.newPage();
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
            await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
            await new Promise(resolve => setTimeout(resolve, 3000));
            
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
            
            if (downloadInfo.downloadUrl) {
                return {
                    name: downloadInfo.filename,
                    downloadUrl: downloadInfo.downloadUrl,
                    extractedBy: 'browser'
                };
            }
            
            const currentUrl = await page.url();
            const testUrl = currentUrl + (currentUrl.includes('?') ? '&' : '?') + 'download=1';
            
            return {
                name: downloadInfo.filename,
                downloadUrl: testUrl,
                extractedBy: 'browser_param'
            };
            
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
        
        // Try multiple download URL patterns
        const downloadUrls = [
            finalUrl + (finalUrl.includes('?') ? '&' : '?') + 'download=1',
            finalUrl.replace('/view', '/download'),
            finalUrl.replace('onedrive.live.com', 'api.onedrive.com') + '/content'
        ];
        
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
                
                console.log(chalk.green(`✅ Success with URL ${i + 1}`));
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
        const tempDir = await fs.mkdtemp(path.join(require('os').tmpdir(), 'onedrive-'));
        
        try {
            const fileInfo = await this.extractOneDriveInfo(url);
            const filePath = await this.downloadFile(fileInfo, tempDir);
            const r2Key = r2Prefix ? `${r2Prefix}/${fileInfo.name}` : fileInfo.name;
            await this.uploadToR2(filePath, r2Key);
            
            console.log(chalk.green(`🎉 Success: ${fileInfo.name}`));
            return true;
            
        } catch (error) {
            console.error(chalk.red(`❌ Failed: ${error.message}`));
            return false;
        } finally {
            await fs.remove(tempDir);
        }
    }
}

program
    .name('onedrive-to-r2')
    .description('Download OneDrive files to Cloudflare R2')
    .version('1.0.0')
    .argument('[url]', 'OneDrive URL')
    .option('-p, --prefix <prefix>', 'R2 prefix')
    .action(async (url, options) => {
        if (!url) {
            console.error(chalk.red('❌ Please provide a URL'));
            return;
        }
        
        const downloader = new OneDriveToR2();
        await downloader.processLink(url, options.prefix);
    });

program.parse(); 