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
        const localPath = path.join(tempDir, `${Date.now()}-${fileName}`); // Add timestamp to avoid conflicts
        
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
            
            // Clean up temporary file immediately after successful upload
            await this.cleanupTempFile(localPath);
            console.log(chalk.gray(`🧹 Cleaned up temporary file`));
            
            return uploadResult;
            
        } catch (error) {
            // Always clean up on error, with extra logging
            await this.cleanupTempFile(localPath, true);
            throw error;
        }
    }
    
    async cleanupTempFile(filePath, isError = false) {
        try {
            if (await fs.pathExists(filePath)) {
                await fs.remove(filePath);
                if (isError) {
                    console.log(chalk.gray(`🧹 Cleaned up temporary file after error`));
                }
            }
        } catch (cleanupError) {
            console.warn(chalk.yellow(`⚠️  Warning: Could not clean up temporary file ${filePath}: ${cleanupError.message}`));
        }
    }
    
    async cleanupTempDirectory() {
        try {
            const tempDir = path.join(require('os').tmpdir(), 'r2-to-apivideo');
            if (await fs.pathExists(tempDir)) {
                // List files in temp directory
                const files = await fs.readdir(tempDir);
                if (files.length > 0) {
                    console.log(chalk.gray(`🧹 Cleaning up ${files.length} remaining temporary files...`));
                    await fs.remove(tempDir);
                    console.log(chalk.gray(`✅ Temporary directory cleaned`));
                }
            }
        } catch (cleanupError) {
            console.warn(chalk.yellow(`⚠️  Warning: Could not clean up temporary directory: ${cleanupError.message}`));
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
            
            // Final cleanup of temp directory
            await this.cleanupTempDirectory();
            
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
            
            // Cleanup after single file transfer
            await transferTool.cleanupTempDirectory();
            
        } catch (error) {
            console.error(chalk.red(`❌ Single file transfer failed: ${error.message}`));
            
            // Ensure cleanup on error
            const transferTool = new R2ToApiVideo();
            await transferTool.cleanupTempDirectory();
            
            process.exit(1);
        }
    });

program
    .command('local')
    .description('Upload a local video file directly to api.video')
    .argument('<file-path>', 'Local path to the video file')
    .option('-t, --title <title>', 'Title for the video')
    .option('-d, --description <description>', 'Description for the video')
    .option('--tags <tags>', 'Comma-separated tags for the video', 'local-upload,automated')
    .action(async (filePath, options) => {
        try {
            const transferTool = new R2ToApiVideo();
            
            // Check if file exists and is a video
            if (!await fs.pathExists(filePath)) {
                throw new Error(`File not found: ${filePath}`);
            }
            
            const stats = await fs.stat(filePath);
            if (!stats.isFile()) {
                throw new Error(`Path is not a file: ${filePath}`);
            }
            
            // Check file extension
            const ext = path.extname(filePath).toLowerCase();
            const videoExtensions = ['.mp4', '.m4v', '.mov', '.avi', '.mkv', '.webm', '.flv', '.wmv'];
            if (!videoExtensions.includes(ext)) {
                console.warn(chalk.yellow(`⚠️  Warning: ${ext} might not be a supported video format`));
            }
            
            console.log(chalk.blue(`📁 Uploading local file: ${filePath}`));
            console.log(chalk.blue(`📊 File size: ${transferTool.formatBytes(stats.size)}`));
            
            const fileName = path.basename(filePath);
            const uploadResult = await transferTool.uploadToApiVideo(filePath, {
                title: options.title || fileName.replace(/\.[^/.]+$/, ""),
                description: options.description || `Uploaded from local file: ${fileName}`,
                tags: options.tags ? options.tags.split(',').map(tag => tag.trim()) : ['local-upload', 'automated'],
                customMetadata: [
                    { key: 'source', value: 'local-file' },
                    { key: 'original_path', value: filePath }
                ]
            });
            
            console.log(chalk.green('\n✅ Local file upload complete!'));
            console.log(chalk.cyan(`Video ID: ${uploadResult.videoId}`));
            console.log(chalk.cyan(`Player URL: ${uploadResult.playerUrl}`));
            
        } catch (error) {
            console.error(chalk.red(`❌ Local file upload failed: ${error.message}`));
            process.exit(1);
        }
    });

program
    .command('local-batch')
    .description('Upload multiple local video files to api.video')
    .argument('<directory>', 'Directory containing video files')
    .option('-p, --pattern <pattern>', 'File pattern to match (glob)', '**/*.{mp4,m4v,mov,avi,mkv,webm}')
    .option('-t, --title-prefix <prefix>', 'Prefix for video titles')
    .option('-d, --description <description>', 'Description for uploaded videos')
    .option('--tags <tags>', 'Comma-separated tags for videos', 'local-batch,automated')
    .option('-r, --report <path>', 'Path to save upload report', 'local-upload-report.json')
    .action(async (directory, options) => {
        try {
            const transferTool = new R2ToApiVideo();
            const glob = require('glob');
            
            // Check if directory exists
            if (!await fs.pathExists(directory)) {
                throw new Error(`Directory not found: ${directory}`);
            }
            
            const stats = await fs.stat(directory);
            if (!stats.isDirectory()) {
                throw new Error(`Path is not a directory: ${directory}`);
            }
            
            // Find video files
            const pattern = path.join(directory, options.pattern);
            const files = glob.sync(pattern);
            
            if (files.length === 0) {
                console.log(chalk.yellow(`⚠️  No video files found in ${directory} matching pattern: ${options.pattern}`));
                return;
            }
            
            console.log(chalk.blue(`🔍 Found ${files.length} video files to upload`));
            
            const results = [];
            const progressBar = new cliProgress.SingleBar({
                format: 'Progress |{bar}| {percentage}% | {value}/{total} files | Current: {filename}',
                barCompleteChar: '\u2588',
                barIncompleteChar: '\u2591',
                hideCursor: true
            });
            
            progressBar.start(files.length, 0, { filename: 'Starting...' });
            
            for (let i = 0; i < files.length; i++) {
                const filePath = files[i];
                const fileName = path.basename(filePath);
                
                progressBar.update(i, { filename: fileName });
                
                try {
                    const fileStats = await fs.stat(filePath);
                    console.log(chalk.blue(`\n📤 Uploading: ${fileName} (${transferTool.formatBytes(fileStats.size)})`));
                    
                    const uploadResult = await transferTool.uploadToApiVideo(filePath, {
                        title: (options.titlePrefix ? options.titlePrefix + ' ' : '') + fileName.replace(/\.[^/.]+$/, ""),
                        description: options.description || `Batch uploaded from: ${fileName}`,
                        tags: options.tags ? options.tags.split(',').map(tag => tag.trim()) : ['local-batch', 'automated'],
                        customMetadata: [
                            { key: 'source', value: 'local-batch' },
                            { key: 'original_path', value: filePath }
                        ]
                    });
                    
                    results.push({ ...uploadResult, status: 'success', filePath });
                    
                } catch (error) {
                    console.log(chalk.red(`\n❌ Failed to upload ${fileName}: ${error.message}`));
                    results.push({ 
                        originalFileName: fileName, 
                        filePath,
                        status: 'error', 
                        error: error.message 
                    });
                }
            }
            
            progressBar.update(files.length, { filename: 'Complete!' });
            progressBar.stop();
            
            // Summary
            const successful = results.filter(r => r.status === 'success').length;
            const failed = results.filter(r => r.status === 'error').length;
            
            console.log(chalk.green(`\n✅ Local batch upload complete!`));
            console.log(chalk.green(`   Successful: ${successful}`));
            if (failed > 0) {
                console.log(chalk.red(`   Failed: ${failed}`));
            }
            
            // Generate report
            await transferTool.generateReport(results, options.report);
            
        } catch (error) {
            console.error(chalk.red(`❌ Local batch upload failed: ${error.message}`));
            process.exit(1);
        }
    });

// Global cleanup on process exit
async function globalCleanup() {
    try {
        const tempDir = path.join(require('os').tmpdir(), 'r2-to-apivideo');
        if (await fs.pathExists(tempDir)) {
            await fs.remove(tempDir);
            console.log(chalk.gray('\n🧹 Final cleanup completed'));
        }
    } catch (error) {
        // Silent cleanup failure on exit
    }
}

// Register cleanup handlers
process.on('SIGINT', async () => {
    console.log(chalk.yellow('\n⚠️  Received interrupt signal, cleaning up...'));
    await globalCleanup();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log(chalk.yellow('\n⚠️  Received terminate signal, cleaning up...'));
    await globalCleanup();
    process.exit(0);
});

process.on('uncaughtException', async (error) => {
    console.error(chalk.red('\n❌ Uncaught exception occurred:'), error);
    await globalCleanup();
    process.exit(1);
});

process.on('unhandledRejection', async (reason, promise) => {
    console.error(chalk.red('\n❌ Unhandled promise rejection:'), reason);
    await globalCleanup();
    process.exit(1);
});

// Handle no command
if (process.argv.length === 2) {
    program.help();
}

program.parse(); 