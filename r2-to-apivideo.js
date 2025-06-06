#!/usr/bin/env node

const fs = require('fs-extra');
const path = require('path');
const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const ApiVideoClient = require('@api.video/nodejs-client');
const { program } = require('commander');
const chalk = require('chalk');
const cliProgress = require('cli-progress');
require('dotenv').config();

class R2ToApiVideo {
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
        
        // Initialize api.video client
        this.apiVideoClient = new ApiVideoClient({ 
            apiKey: process.env.APIVIDEO_API_KEY,
            baseUri: process.env.APIVIDEO_BASE_URI || 'https://ws.api.video'
        });
        
        this.validateConfig();
        console.log(chalk.green('✅ R2 to api.video transfer tool initialized'));
    }
    
    validateConfig() {
        const required = ['R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME', 'APIVIDEO_API_KEY'];
        const missing = required.filter(key => !process.env[key]);
        
        if (missing.length > 0) {
            console.error(chalk.red(`❌ Missing environment variables: ${missing.join(', ')}`));
            console.log(chalk.yellow('Please ensure your .env file contains all required variables.'));
            process.exit(1);
        }
    }
    
    async listMp4Files(prefix = '') {
        console.log(chalk.blue(`🔍 Searching for MP4 files in R2 bucket: ${this.bucketName}`));
        
        const mp4Files = [];
        let continuationToken = undefined;
        
        do {
            try {
                const command = new ListObjectsV2Command({
                    Bucket: this.bucketName,
                    Prefix: prefix,
                    ContinuationToken: continuationToken
                });
                
                const response = await this.s3Client.send(command);
                
                if (response.Contents) {
                    const mp4Objects = response.Contents.filter(obj => {
                        const key = obj.Key.toLowerCase();
                        return key.endsWith('.mp4') || key.endsWith('.m4v');
                    });
                    
                    mp4Files.push(...mp4Objects);
                }
                
                continuationToken = response.NextContinuationToken;
            } catch (error) {
                console.error(chalk.red(`❌ Error listing files from R2: ${error.message}`));
                throw error;
            }
        } while (continuationToken);
        
        console.log(chalk.green(`✅ Found ${mp4Files.length} MP4 files in R2`));
        return mp4Files;
    }
    
    async downloadFromR2(key, localPath) {
        try {
            const command = new GetObjectCommand({
                Bucket: this.bucketName,
                Key: key
            });
            
            const response = await this.s3Client.send(command);
            const stream = response.Body;
            
            await fs.ensureDir(path.dirname(localPath));
            const writeStream = fs.createWriteStream(localPath);
            
            return new Promise((resolve, reject) => {
                stream.pipe(writeStream);
                writeStream.on('finish', resolve);
                writeStream.on('error', reject);
                stream.on('error', reject);
            });
        } catch (error) {
            console.error(chalk.red(`❌ Error downloading ${key} from R2: ${error.message}`));
            throw error;
        }
    }
    
    async uploadToApiVideo(filePath, metadata = {}) {
        try {
            const fileName = path.basename(filePath);
            const videoTitle = metadata.title || fileName.replace(/\.[^/.]+$/, ""); // Remove extension
            
            console.log(chalk.blue(`📤 Uploading ${fileName} to api.video...`));
            
            // Create video object first
            const videoCreationPayload = {
                title: videoTitle,
                description: metadata.description || `Uploaded from R2: ${fileName}`,
                tags: metadata.tags || ['r2-upload', 'automated'],
                metadata: [
                    { key: 'source', value: 'cloudflare-r2' },
                    { key: 'original_filename', value: fileName },
                    ...(metadata.customMetadata || [])
                ]
            };
            
            const video = await this.apiVideoClient.videos.create(videoCreationPayload);
            console.log(chalk.green(`✅ Video object created with ID: ${video.videoId}`));
            
            // Upload the video file
            const uploadResult = await this.apiVideoClient.videos.upload(video.videoId, filePath);
            
            console.log(chalk.green(`✅ Successfully uploaded ${fileName} to api.video`));
            console.log(chalk.cyan(`   Video ID: ${uploadResult.videoId}`));
            console.log(chalk.cyan(`   Player URL: ${uploadResult.assets?.player || 'N/A'}`));
            
            return {
                videoId: uploadResult.videoId,
                playerUrl: uploadResult.assets?.player,
                originalFileName: fileName,
                title: videoTitle
            };
            
        } catch (error) {
            console.error(chalk.red(`❌ Error uploading to api.video: ${error.message}`));
            throw error;
        }
    }
    
    async processFile(r2Key, options = {}) {
        const fileName = path.basename(r2Key);
        const tempDir = path.join(require('os').tmpdir(), 'r2-to-apivideo');
        const localPath = path.join(tempDir, fileName);
        
        try {
            console.log(chalk.blue(`\n🔄 Processing: ${r2Key}`));
            
            // Download from R2
            console.log(chalk.blue(`⬇️  Downloading from R2...`));
            await this.downloadFromR2(r2Key, localPath);
            
            // Get file size for progress
            const stats = await fs.stat(localPath);
            console.log(chalk.green(`✅ Downloaded ${this.formatBytes(stats.size)}`));
            
            // Upload to api.video
            const uploadResult = await this.uploadToApiVideo(localPath, {
                title: options.title || fileName.replace(/\.[^/.]+$/, ""),
                description: options.description,
                tags: options.tags,
                customMetadata: options.metadata
            });
            
            // Clean up temporary file
            await fs.remove(localPath);
            
            return uploadResult;
            
        } catch (error) {
            // Clean up on error
            if (await fs.pathExists(localPath)) {
                await fs.remove(localPath);
            }
            throw error;
        }
    }
    
    async processAllFiles(options = {}) {
        try {
            const mp4Files = await this.listMp4Files(options.prefix);
            
            if (mp4Files.length === 0) {
                console.log(chalk.yellow('⚠️  No MP4 files found in the specified bucket/prefix'));
                return [];
            }
            
            console.log(chalk.blue(`\n🚀 Starting transfer of ${mp4Files.length} files...`));
            
            const results = [];
            const progressBar = new cliProgress.SingleBar({
                format: 'Progress |{bar}| {percentage}% | {value}/{total} files | Current: {filename}',
                barCompleteChar: '\u2588',
                barIncompleteChar: '\u2591',
                hideCursor: true
            });
            
            progressBar.start(mp4Files.length, 0, { filename: 'Starting...' });
            
            for (let i = 0; i < mp4Files.length; i++) {
                const file = mp4Files[i];
                const fileName = path.basename(file.Key);
                
                progressBar.update(i, { filename: fileName });
                
                try {
                    const result = await this.processFile(file.Key, options);
                    results.push({ ...result, status: 'success' });
                } catch (error) {
                    console.log(chalk.red(`\n❌ Failed to process ${file.Key}: ${error.message}`));
                    results.push({ 
                        originalFileName: fileName, 
                        status: 'error', 
                        error: error.message 
                    });
                }
            }
            
            progressBar.update(mp4Files.length, { filename: 'Complete!' });
            progressBar.stop();
            
            // Summary
            const successful = results.filter(r => r.status === 'success').length;
            const failed = results.filter(r => r.status === 'error').length;
            
            console.log(chalk.green(`\n✅ Transfer complete!`));
            console.log(chalk.green(`   Successful: ${successful}`));
            if (failed > 0) {
                console.log(chalk.red(`   Failed: ${failed}`));
            }
            
            return results;
            
        } catch (error) {
            console.error(chalk.red(`❌ Error during batch processing: ${error.message}`));
            throw error;
        }
    }
    
    formatBytes(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
    
    async generateReport(results, outputPath = 'transfer-report.json') {
        const report = {
            timestamp: new Date().toISOString(),
            summary: {
                total: results.length,
                successful: results.filter(r => r.status === 'success').length,
                failed: results.filter(r => r.status === 'error').length
            },
            results: results
        };
        
        await fs.writeJson(outputPath, report, { spaces: 2 });
        console.log(chalk.green(`📊 Report saved to: ${outputPath}`));
        return report;
    }
}

// CLI Configuration
program
    .name('r2-to-apivideo')
    .description('Transfer MP4 files from Cloudflare R2 to api.video')
    .version('1.0.0');

program
    .command('transfer')
    .description('Transfer all MP4 files from R2 to api.video')
    .option('-p, --prefix <prefix>', 'R2 key prefix to filter files', '')
    .option('-t, --title-prefix <prefix>', 'Prefix for video titles', '')
    .option('-d, --description <description>', 'Description for uploaded videos')
    .option('--tags <tags>', 'Comma-separated tags for videos', 'r2-upload,automated')
    .option('-r, --report <path>', 'Path to save transfer report', 'transfer-report.json')
    .action(async (options) => {
        try {
            const transferTool = new R2ToApiVideo();
            
            const transferOptions = {
                prefix: options.prefix,
                description: options.description,
                tags: options.tags ? options.tags.split(',').map(tag => tag.trim()) : ['r2-upload', 'automated']
            };
            
            const results = await transferTool.processAllFiles(transferOptions);
            await transferTool.generateReport(results, options.report);
            
            process.exit(0);
        } catch (error) {
            console.error(chalk.red(`❌ Transfer failed: ${error.message}`));
            process.exit(1);
        }
    });

program
    .command('list')
    .description('List MP4 files in R2 bucket')
    .option('-p, --prefix <prefix>', 'R2 key prefix to filter files', '')
    .action(async (options) => {
        try {
            const transferTool = new R2ToApiVideo();
            const files = await transferTool.listMp4Files(options.prefix);
            
            console.log(chalk.blue('\n📋 MP4 Files found:'));
            files.forEach((file, index) => {
                console.log(chalk.cyan(`${index + 1}. ${file.Key} (${transferTool.formatBytes(file.Size)})`));
            });
            
        } catch (error) {
            console.error(chalk.red(`❌ Listing failed: ${error.message}`));
            process.exit(1);
        }
    });

program
    .command('single')
    .description('Transfer a single file from R2 to api.video')
    .argument('<r2-key>', 'R2 key of the file to transfer')
    .option('-t, --title <title>', 'Title for the video')
    .option('-d, --description <description>', 'Description for the video')
    .option('--tags <tags>', 'Comma-separated tags for the video', 'r2-upload,automated')
    .action(async (r2Key, options) => {
        try {
            const transferTool = new R2ToApiVideo();
            
            const transferOptions = {
                title: options.title,
                description: options.description,
                tags: options.tags ? options.tags.split(',').map(tag => tag.trim()) : ['r2-upload', 'automated']
            };
            
            const result = await transferTool.processFile(r2Key, transferOptions);
            console.log(chalk.green('\n✅ Single file transfer complete!'));
            console.log(chalk.cyan(`Video ID: ${result.videoId}`));
            console.log(chalk.cyan(`Player URL: ${result.playerUrl}`));
            
        } catch (error) {
            console.error(chalk.red(`❌ Single file transfer failed: ${error.message}`));
            process.exit(1);
        }
    });

// Handle no command
if (process.argv.length === 2) {
    program.help();
}

program.parse(); 