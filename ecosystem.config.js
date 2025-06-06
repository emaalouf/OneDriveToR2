module.exports = {
  apps: [
    {
      name: 'r2-to-apivideo',
      script: 'pm2-transfer.js',
      args: 'transfer --prefix "" --tags "pm2,automated,r2-upload"',
      instances: 1,
      autorestart: false, // Don't auto-restart completed transfers
      watch: false,
      max_memory_restart: '3G',
      env: {
        NODE_ENV: 'production',
        FORCE_COLOR: '1'
      },
      env_development: {
        NODE_ENV: 'development',
        FORCE_COLOR: '1'
      },
      // Logging configuration
      log_file: './logs/r2-to-apivideo.log',
      out_file: './logs/r2-to-apivideo-out.log',
      error_file: './logs/r2-to-apivideo-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      
      // Process management
      min_uptime: '10s',
      max_restarts: 1, // Only restart once on failure
      restart_delay: 5000,
      kill_timeout: 10000, // Give time for cleanup
      
      // Advanced options
      merge_logs: true,
      combine_logs: true,
      
      // Uncomment to restart daily at 2 AM
      // cron_restart: '0 2 * * *',
      
      // Memory and CPU monitoring
      monitoring: {
        http: true,
        https: false,
        port: 9615
      }
    },
    {
      // Alternative configuration for single file transfers
      name: 'r2-to-apivideo-single',
      script: 'r2-to-apivideo.js',
      args: 'single',
      instances: 1,
      autorestart: false, // Don't restart single transfers
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production'
      },
      log_file: './logs/r2-to-apivideo-single.log',
      out_file: './logs/r2-to-apivideo-single-out.log',
      error_file: './logs/r2-to-apivideo-single-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      combine_logs: true
    },
    {
      // Configuration for continuous monitoring/listing
      name: 'r2-to-apivideo-monitor',
      script: 'r2-to-apivideo.js',
      args: 'list',
      instances: 1,
      autorestart: false,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production'
      },
      log_file: './logs/r2-to-apivideo-monitor.log',
      out_file: './logs/r2-to-apivideo-monitor-out.log',
      error_file: './logs/r2-to-apivideo-monitor-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      combine_logs: true
    }
  ]
}; 