# 🌐 Browser Setup Guide

## 📊 **VPS Resource Requirements**

### ❌ **Current (Insufficient)**
- 1 CPU, 1GB RAM
- Browser crashes with "Browser closed unexpectedly"
- Only gets 320KB previews instead of full files

### ✅ **Recommended**
- **2+ CPUs, 4GB RAM** (minimum)
- **4+ CPUs, 8GB RAM** (optimal for heavy workloads)

## 🐳 **Docker Solution (Recommended)**

### **Build & Run**
```bash
# Build the browser-optimized image
docker build -f Dockerfile.browser -t onedrive-to-r2-browser .

# Run single link
docker run --rm \
  --shm-size=2g \
  --security-opt seccomp:unconfined \
  -v $(pwd)/.env:/app/.env:ro \
  onedrive-to-r2-browser "https://1drv.ms/v/..."

# Or use docker-compose
docker-compose -f docker-compose.browser.yml run --rm onedrive-to-r2-browser "https://1drv.ms/v/..."
```

### **Benefits**
- ✅ Isolated browser environment
- ✅ Optimized Chrome installation
- ✅ Virtual display (Xvfb)
- ✅ Proper memory management
- ✅ Better stability

## 🔧 **Manual VPS Setup**

### **1. Upgrade VPS**
```bash
# Check current resources
free -h
nproc

# Upgrade to 2+ CPUs, 4GB+ RAM through your provider
```

### **2. Install Google Chrome**
```bash
# Install Chrome (more stable than Chromium)
wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | apt-key add -
echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list
apt update && apt install -y google-chrome-stable

# Install virtual display
apt install -y xvfb

# Update Python dependencies
pip3 install psutil
```

### **3. Run with Virtual Display**
```bash
# Start virtual display
Xvfb :99 -screen 0 1280x1024x24 &
export DISPLAY=:99

# Run script
python3 onedrive_to_r2.py "https://1drv.ms/v/..."
```

## 🎯 **Expected Results**

After proper setup:
- ✅ Browser extraction works
- ✅ Downloads full 150MB videos (not 320KB previews)
- ✅ Better OneDrive link handling
- ✅ Stable operation

## 🚨 **Troubleshooting**

### **Still getting previews?**
- Ensure you have actual file links, not folder/view links
- Try different OneDrive sharing settings
- Check if file is truly 150MB (some videos have multiple resolutions)

### **Browser still crashing?**
- Increase VPS RAM to 4GB+
- Use Docker solution
- Check `/tmp` space availability

### **Memory issues?**
```bash
# Monitor memory usage
htop
# or
watch -n 1 'free -h'
``` 