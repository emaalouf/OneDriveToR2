#!/usr/bin/env node

/**
 * PM2 Wrapper for R2 to api.video Transfer
 * This script allows PM2 to run the transfer with custom arguments
 */

const { spawn } = require('child_process');
const path = require('path');

// Get arguments from PM2 or command line
const args = process.argv.slice(2);

// Default to 'transfer' command if no args provided
if (args.length === 0) {
    args.push('transfer');
}

// Construct the command
const scriptPath = path.join(__dirname, 'r2-to-apivideo.js');
const child = spawn('node', [scriptPath, ...args], {
    stdio: 'inherit',
    env: process.env
});

// Handle process events
child.on('close', (code) => {
    console.log(`Transfer process exited with code ${code}`);
    process.exit(code);
});

child.on('error', (error) => {
    console.error(`Failed to start transfer process: ${error}`);
    process.exit(1);
});

// Forward signals
process.on('SIGINT', () => {
    child.kill('SIGINT');
});

process.on('SIGTERM', () => {
    child.kill('SIGTERM');
}); 