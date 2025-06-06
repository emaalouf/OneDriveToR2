# VPS Deployment Guide

This guide covers multiple ways to deploy the OneDrive to R2 downloader on a VPS.

## 🚀 Quick Deployment Options

### Option 1: Automated Script (Recommended)
### Option 2: Docker Deployment
### Option 3: Manual Installation

---

## Option 1: Automated Script Deployment

### Prerequisites
- Ubuntu 18.04+ or Debian 10+ VPS
- Root or sudo access
- Internet connection

### Step-by-Step

1. **Connect to your VPS:**
   ```bash
   ssh root@your-vps-ip
   # or
   ssh your-user@your-vps-ip
   ```

2. **Upload project files:**
   ```bash
   # Method 1: Using SCP
   scp -r * root@your-vps-ip:/tmp/onedrive-to-r2/
   
   # Method 2: Using Git (if repo is public)
   git clone https://github.com/your-repo/onedrive-to-r2.git
   cd onedrive-to-r2
   
   # Method 3: Manual upload via SFTP/FTP
   ```

3. **Run deployment script:**
   ```bash
   chmod +x deploy.sh
   sudo ./deploy.sh
   ```

4. **Configure credentials:**
   ```bash
   sudo nano /opt/onedrive-to-r2/.env
   ```
   Add your R2 credentials:
   ```env
   R2_ENDPOINT_URL=https://your-account-id.r2.cloudflarestorage.com
   R2_ACCESS_KEY_ID=your_access_key_id
   R2_SECRET_ACCESS_KEY=your_secret_access_key
   R2_BUCKET_NAME=your-bucket-name
   ```

5. **Add OneDrive links:**
   ```bash
   sudo nano /opt/onedrive-to-r2/links.txt
   ```

6. **Start the service:**
   ```bash
   sudo systemctl enable onedrive-to-r2
   sudo systemctl start onedrive-to-r2
   sudo systemctl status onedrive-to-r2
   ```

### Management Commands

```bash
# Check service status
sudo systemctl status onedrive-to-r2

# View live logs
sudo journalctl -u onedrive-to-r2 -f

# Restart service
sudo systemctl restart onedrive-to-r2

# Stop service
sudo systemctl stop onedrive-to-r2

# Run manually
sudo -u onedrive-to-r2 /opt/onedrive-to-r2/run.sh --help
```

---

## Option 2: Docker Deployment

### Prerequisites
- VPS with Docker and Docker Compose installed
- 2GB+ RAM recommended

### Step-by-Step

1. **Install Docker (if not installed):**
   ```bash
   curl -fsSL https://get.docker.com -o get-docker.sh
   sudo sh get-docker.sh
   sudo usermod -aG docker $USER
   
   # Install Docker Compose
   sudo curl -L "https://github.com/docker/compose/releases/download/v2.20.0/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
   sudo chmod +x /usr/local/bin/docker-compose
   ```

2. **Upload project files:**
   ```bash
   scp -r * your-user@your-vps-ip:~/onedrive-to-r2/
   ```

3. **Set up environment:**
   ```bash
   cd ~/onedrive-to-r2
   cp .env.example .env
   nano .env  # Add your R2 credentials
   nano links.txt  # Add your OneDrive links
   ```

4. **Deploy with Docker Compose:**
   ```bash
   # Build and start
   docker-compose up -d --build
   
   # View logs
   docker-compose logs -f
   
   # Check status
   docker-compose ps
   ```

### Docker Management Commands

```bash
# View logs
docker-compose logs -f onedrive-to-r2

# Restart container
docker-compose restart onedrive-to-r2

# Stop all services
docker-compose down

# Update and restart
docker-compose down && docker-compose up -d --build

# Run one-time job
docker-compose run --rm onedrive-to-r2 python onedrive_to_r2.py "https://your-link"

# Access container shell
docker-compose exec onedrive-to-r2 bash
```

---

## Option 3: Manual Installation

### Prerequisites
- Ubuntu/Debian VPS
- Python 3.7+
- sudo access

### Step-by-Step

1. **Update system:**
   ```bash
   sudo apt update && sudo apt upgrade -y
   sudo apt install python3 python3-pip python3-venv git -y
   ```

2. **Create application directory:**
   ```bash
   sudo mkdir -p /opt/onedrive-to-r2
   sudo chown $USER:$USER /opt/onedrive-to-r2
   cd /opt/onedrive-to-r2
   ```

3. **Upload and setup application:**
   ```bash
   # Upload files here (scp, git, etc.)
   python3 -m venv venv
   source venv/bin/activate
   pip install -r requirements.txt
   ```

4. **Configure environment:**
   ```bash
   cp .env.example .env
   nano .env  # Add R2 credentials
   nano links.txt  # Add OneDrive links
   ```

5. **Test the application:**
   ```bash
   python onedrive_to_r2.py --help
   ```

6. **Set up as service (optional):**
   ```bash
   sudo nano /etc/systemd/system/onedrive-to-r2.service
   ```
   Add service configuration (see deploy.sh for template)

---

## 🔧 VPS Provider Specific Notes

### DigitalOcean
- Use Ubuntu 22.04 droplet
- 1GB RAM minimum, 2GB+ recommended
- Enable firewall in DO dashboard

### AWS EC2
- Use Ubuntu 22.04 AMI
- t3.micro works for testing, t3.small+ for production
- Configure Security Groups (ports 22, 80, 443)

### Vultr/Linode
- Ubuntu 22.04 instance
- 1GB+ RAM recommended
- Configure firewall rules

### Hetzner
- Ubuntu 22.04 CX11 or higher
- Very cost-effective option
- Good network performance

---

## 🔒 Security Best Practices

### Basic Security Setup

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Configure firewall
sudo ufw enable
sudo ufw allow ssh
sudo ufw status

# Disable root login (optional)
sudo nano /etc/ssh/sshd_config
# Set: PermitRootLogin no
sudo systemctl restart ssh

# Create regular user (if using root)
adduser yourusername
usermod -aG sudo yourusername
```

### Application Security

1. **Secure credentials:**
   ```bash
   chmod 600 /opt/onedrive-to-r2/.env
   ```

2. **Run as non-root user** (automated script does this)

3. **Regular updates:**
   ```bash
   # Update system packages
   sudo apt update && sudo apt upgrade -y
   
   # Update Python dependencies
   cd /opt/onedrive-to-r2
   source venv/bin/activate
   pip install --upgrade -r requirements.txt
   ```

---

## 📊 Monitoring & Maintenance

### Log Management

```bash
# View application logs
sudo journalctl -u onedrive-to-r2 -f

# Application log files
tail -f /opt/onedrive-to-r2/logs/output.log
tail -f /opt/onedrive-to-r2/logs/error.log

# System logs
sudo journalctl -f
```

### Performance Monitoring

```bash
# Check system resources
htop
free -h
df -h

# Check service status
systemctl status onedrive-to-r2

# Check network usage
nethogs
```

### Backup Strategy

```bash
# Backup configuration
cp /opt/onedrive-to-r2/.env ~/backup/
cp /opt/onedrive-to-r2/links.txt ~/backup/

# Backup logs (optional)
tar -czf ~/backup/logs-$(date +%Y%m%d).tar.gz /opt/onedrive-to-r2/logs/
```

---

## 🐛 Troubleshooting

### Common Issues

1. **Permission denied:**
   ```bash
   sudo chown -R onedrive-to-r2:onedrive-to-r2 /opt/onedrive-to-r2
   ```

2. **Python dependencies issues:**
   ```bash
   cd /opt/onedrive-to-r2
   source venv/bin/activate
   pip install --upgrade pip
   pip install -r requirements.txt
   ```

3. **Network connectivity:**
   ```bash
   curl -I https://onedrive.live.com
   curl -I https://your-account-id.r2.cloudflarestorage.com
   ```

4. **Service won't start:**
   ```bash
   sudo systemctl status onedrive-to-r2
   sudo journalctl -u onedrive-to-r2 --no-pager
   ```

### Getting Help

Check logs first:
```bash
# Service logs
sudo journalctl -u onedrive-to-r2 -n 50

# Application logs
tail -n 50 /opt/onedrive-to-r2/logs/error.log
```

### Performance Optimization

1. **For large files:**
   - Increase VPS RAM
   - Use SSD storage
   - Consider multiple workers

2. **For many links:**
   - Process in batches
   - Add delays between requests
   - Monitor R2 rate limits

---

## 📋 Post-Deployment Checklist

- [ ] VPS is accessible via SSH
- [ ] Application is installed and running
- [ ] R2 credentials are configured
- [ ] OneDrive links are added
- [ ] Service starts automatically
- [ ] Logs are being written
- [ ] Firewall is configured
- [ ] Backups are set up
- [ ] Monitoring is in place

## 🔄 Updating the Application

### Manual Update
```bash
# Backup current version
sudo cp -r /opt/onedrive-to-r2 /opt/onedrive-to-r2.backup

# Update code
cd /opt/onedrive-to-r2
# Upload new files or git pull

# Restart service
sudo systemctl restart onedrive-to-r2
```

### Docker Update
```bash
cd ~/onedrive-to-r2
docker-compose down
# Update code files
docker-compose up -d --build
``` 