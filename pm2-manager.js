#!/usr/bin/env node

/**
 * PM2 Manager for R2 to api.video Transfer
 * Provides easy commands to manage PM2 processes
 */

const { program } = require('commander');
const { spawn } = require('child_process');
const chalk = require('chalk');

function runPM2Command(command, args = []) {
    return new Promise((resolve, reject) => {
        console.log(chalk.blue(`🚀 Running: pm2 ${command} ${args.join(' ')}`));
        
        const pm2 = spawn('pm2', [command, ...args], {
            stdio: 'inherit'
        });
        
        pm2.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`PM2 command failed with code ${code}`));
            }
        });
        
        pm2.on('error', (error) => {
            reject(error);
        });
    });
}

// CLI Commands
program
    .name('pm2-manager')
    .description('Manage R2 to api.video transfer processes with PM2')
    .version('1.0.0');

program
    .command('start')
    .description('Start the transfer process with PM2')
    .option('-p, --prefix <prefix>', 'R2 prefix filter')
    .option('-d, --description <description>', 'Video description')
    .option('--tags <tags>', 'Comma-separated tags')
    .action(async (options) => {
        try {
            // Build arguments
            let args = ['transfer'];
            if (options.prefix) args.push('--prefix', options.prefix);
            if (options.description) args.push('--description', options.description);
            if (options.tags) args.push('--tags', options.tags);
            
            // Update ecosystem config with custom args
            const argsString = args.join(' ');
            
            await runPM2Command('start', [
                'pm2-transfer.js',
                '--name', 'r2-to-apivideo',
                '--', ...args
            ]);
            
            console.log(chalk.green('✅ Transfer process started with PM2'));
            console.log(chalk.cyan('📊 Monitor with: npm run pm2:monit'));
            console.log(chalk.cyan('📋 View logs with: npm run pm2:logs'));
            
        } catch (error) {
            console.error(chalk.red(`❌ Failed to start: ${error.message}`));
            process.exit(1);
        }
    });

program
    .command('stop')
    .description('Stop the transfer process')
    .action(async () => {
        try {
            await runPM2Command('stop', ['r2-to-apivideo']);
            console.log(chalk.green('✅ Transfer process stopped'));
        } catch (error) {
            console.error(chalk.red(`❌ Failed to stop: ${error.message}`));
        }
    });

program
    .command('restart')
    .description('Restart the transfer process')
    .action(async () => {
        try {
            await runPM2Command('restart', ['r2-to-apivideo']);
            console.log(chalk.green('✅ Transfer process restarted'));
        } catch (error) {
            console.error(chalk.red(`❌ Failed to restart: ${error.message}`));
        }
    });

program
    .command('delete')
    .description('Delete the transfer process from PM2')
    .action(async () => {
        try {
            await runPM2Command('delete', ['r2-to-apivideo']);
            console.log(chalk.green('✅ Transfer process deleted from PM2'));
        } catch (error) {
            console.error(chalk.red(`❌ Failed to delete: ${error.message}`));
        }
    });

program
    .command('status')
    .description('Show PM2 process status')
    .action(async () => {
        try {
            await runPM2Command('status');
        } catch (error) {
            console.error(chalk.red(`❌ Failed to show status: ${error.message}`));
        }
    });

program
    .command('logs')
    .description('Show PM2 logs')
    .option('-f, --follow', 'Follow logs in real-time')
    .option('-l, --lines <number>', 'Number of lines to show', '50')
    .action(async (options) => {
        try {
            const args = ['logs', 'r2-to-apivideo'];
            if (options.follow) args.push('--follow');
            if (options.lines) args.push('--lines', options.lines);
            
            await runPM2Command('logs', args.slice(1));
        } catch (error) {
            console.error(chalk.red(`❌ Failed to show logs: ${error.message}`));
        }
    });

program
    .command('monit')
    .description('Open PM2 monitoring dashboard')
    .action(async () => {
        try {
            await runPM2Command('monit');
        } catch (error) {
            console.error(chalk.red(`❌ Failed to open monitor: ${error.message}`));
        }
    });

program
    .command('single')
    .description('Start a single file transfer')
    .argument('<r2-key>', 'R2 key of file to transfer')
    .option('-t, --title <title>', 'Video title')
    .option('-d, --description <description>', 'Video description')
    .option('--tags <tags>', 'Comma-separated tags')
    .action(async (r2Key, options) => {
        try {
            let args = ['single', r2Key];
            if (options.title) args.push('--title', options.title);
            if (options.description) args.push('--description', options.description);
            if (options.tags) args.push('--tags', options.tags);
            
            await runPM2Command('start', [
                'pm2-transfer.js',
                '--name', 'r2-to-apivideo-single',
                '--autorestart', 'false',
                '--', ...args
            ]);
            
            console.log(chalk.green('✅ Single file transfer started with PM2'));
            console.log(chalk.cyan('📊 Monitor with: pm2 logs r2-to-apivideo-single'));
            
        } catch (error) {
            console.error(chalk.red(`❌ Failed to start single transfer: ${error.message}`));
            process.exit(1);
        }
    });

program
    .command('cleanup')
    .description('Clean up all transfer processes')
    .action(async () => {
        try {
            console.log(chalk.blue('🧹 Cleaning up all transfer processes...'));
            
            // Try to delete all related processes
            const processes = ['r2-to-apivideo', 'r2-to-apivideo-single', 'r2-to-apivideo-monitor'];
            
            for (const proc of processes) {
                try {
                    await runPM2Command('delete', [proc]);
                } catch (error) {
                    // Ignore errors for non-existent processes
                }
            }
            
            console.log(chalk.green('✅ Cleanup complete'));
            
        } catch (error) {
            console.error(chalk.red(`❌ Cleanup failed: ${error.message}`));
        }
    });

// Show help if no command provided
if (process.argv.length === 2) {
    program.help();
}

program.parse(); 