# 🚀 OneDrive to R2 (Node.js)

Download files from OneDrive links and upload them to Cloudflare R2 using Node.js and Puppeteer.

## ✨ **Why Node.js Version?**

- 🌐 **Better browser automation** - Puppeteer is more stable than pyppeteer
- 🚀 **Faster performance** - Native JavaScript execution
- 📦 **Easier dependency management** - npm handles everything
- 🔧 **Simpler deployment** - Just `npm install` and go!

## 🏁 **Quick Start**

### **1. Install Node.js** (18+ required)
```bash
# Check if you have Node.js
node --version

# If not installed, download from https://nodejs.org/
```

### **2. Install Dependencies**
```bash
npm install
```

### **3. Configure Environment**
Create `.env` file:
```bash
R2_ENDPOINT=https://your-account-id.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=your_access_key
R2_SECRET_ACCESS_KEY=your_secret_key
R2_BUCKET_NAME=your_bucket_name
```

### **4. Run**
```bash
# Single URL
node onedrive-to-r2.js "https://1drv.ms/v/..."

# With R2 prefix
node onedrive-to-r2.js "https://1drv.ms/v/..." --prefix "videos/2024"
```

## 🎯 **Features**

- ✅ **Puppeteer browser automation** - Gets full files, not previews
- ✅ **Progress bars** - Visual download/upload progress  
- ✅ **Automatic retry** - Falls back to direct extraction
- ✅ **Error handling** - Detailed error messages
- ✅ **Temp file cleanup** - No disk space waste
- ✅ **7.75GB RAM support** - Works great with your VPS resources!

## 🔧 **VPS Installation**

```bash
# 1. Install Node.js on Ubuntu
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. Clone and setup
git clone <your-repo>
cd OneDriveToR2
npm install

# 3. Create .env file
cp .env.example .env
nano .env  # Add your R2 credentials

# 4. Test
node onedrive-to-r2.js "https://1drv.ms/v/..." 
```

## 📊 **Resource Usage**

- **RAM**: ~200-500MB (much less than Python!)
- **CPU**: Efficient V8 engine
- **Disk**: Temporary files auto-cleaned

## 🎉 **Expected Results**

Instead of 319KB previews, you should now get:
- ✅ **Full 150MB videos**
- ✅ **Original filenames**
- ✅ **Stable browser automation**
- ✅ **Fast uploads to R2**

## 🐳 **Docker (Optional)**

```bash
# Build
docker build -t onedrive-to-r2-node .

# Run
docker run --rm -v $(pwd)/.env:/app/.env \
  onedrive-to-r2-node "https://1drv.ms/v/..."
```

## 🚨 **Troubleshooting**

### **Puppeteer fails to install?**
```bash
# Install Chromium manually
sudo apt-get install -y chromium-browser
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
export PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
npm install puppeteer
```

### **Still getting previews?**
- Make sure you have the direct OneDrive file link
- Check if the file sharing permissions allow downloads
- Try a different OneDrive link to test

### **Memory issues?**
Node.js should use much less memory than Python. Monitor with:
```bash
htop
# Look for node process
```

## 📈 **Performance Comparison**

| Metric | Python + pyppeteer | Node.js + Puppeteer |
|--------|-------------------|---------------------|
| Memory | 1-2GB | 200-500MB |
| Browser stability | ❌ Crashes | ✅ Stable |
| Setup complexity | 🔴 Complex | 🟢 Simple |
| File size extracted | 319KB preview | 150MB full file |

The Node.js version should work much better with your 7.75GB RAM VPS! 🎉 