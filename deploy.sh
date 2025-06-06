#!/bin/bash

# OneDrive to R2 Downloader - VPS Deployment Script
# This script sets up the application on a fresh Ubuntu/Debian VPS

set -e  # Exit on any error

echo "🚀 Starting OneDrive to R2 Downloader deployment..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
APP_NAME="onedrive-to-r2"
APP_DIR="/opt/$APP_NAME"
SERVICE_USER="$APP_NAME"
PYTHON_VERSION="3"

# Functions
print_status() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if running as root
if [[ $EUID -ne 0 ]]; then
   print_error "This script must be run as root (use sudo)"
   exit 1
fi

print_status "Updating system packages..."
apt update && apt upgrade -y

print_status "Installing required system packages..."
apt install -y \
    python3 \
    python3-pip \
    python3-venv \
    git \
    curl \
    wget \
    unzip \
    systemd \
    nginx \
    ufw \
    htop

# Ensure Python 3 is available (should be installed with the packages above)
if ! command -v python3 &> /dev/null; then
    print_error "Python 3 installation failed"
    exit 1
fi

# Create application user
if ! id "$SERVICE_USER" &>/dev/null; then
    print_status "Creating application user: $SERVICE_USER"
    useradd --system --home $APP_DIR --shell /bin/bash $SERVICE_USER
fi

# Create application directory
print_status "Setting up application directory: $APP_DIR"
mkdir -p $APP_DIR
chown $SERVICE_USER:$SERVICE_USER $APP_DIR

# Copy application files
print_status "Copying application files..."
if [ -f "onedrive_to_r2.py" ]; then
    cp onedrive_to_r2.py $APP_DIR/
    cp requirements.txt $APP_DIR/
    cp .env.example $APP_DIR/
    cp links.txt $APP_DIR/
    chown -R $SERVICE_USER:$SERVICE_USER $APP_DIR
else
    print_error "Application files not found. Make sure you're running this from the project directory."
    exit 1
fi

# Set up Python virtual environment
print_status "Creating Python virtual environment..."
sudo -u $SERVICE_USER python3 -m venv $APP_DIR/venv

# Install Python dependencies
print_status "Installing Python dependencies..."
sudo -u $SERVICE_USER $APP_DIR/venv/bin/pip install --upgrade pip
sudo -u $SERVICE_USER $APP_DIR/venv/bin/pip install -r $APP_DIR/requirements.txt

# Create configuration file
print_status "Setting up configuration..."
if [ ! -f "$APP_DIR/.env" ]; then
    cp $APP_DIR/.env.example $APP_DIR/.env
    chown $SERVICE_USER:$SERVICE_USER $APP_DIR/.env
    chmod 600 $APP_DIR/.env
    print_warning "Please edit $APP_DIR/.env with your R2 credentials!"
fi

# Create logs directory
mkdir -p $APP_DIR/logs
chown $SERVICE_USER:$SERVICE_USER $APP_DIR/logs

# Create systemd service
print_status "Creating systemd service..."
cat > /etc/systemd/system/$APP_NAME.service << EOF
[Unit]
Description=OneDrive to R2 Downloader
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$APP_DIR
Environment=PATH=$APP_DIR/venv/bin
ExecStart=$APP_DIR/venv/bin/python onedrive_to_r2.py --file links.txt
Restart=always
RestartSec=10
StandardOutput=append:$APP_DIR/logs/output.log
StandardError=append:$APP_DIR/logs/error.log

[Install]
WantedBy=multi-user.target
EOF

# Create wrapper script for manual execution
print_status "Creating wrapper script..."
cat > $APP_DIR/run.sh << 'EOF'
#!/bin/bash
cd "$(dirname "$0")"
source venv/bin/activate
python onedrive_to_r2.py "$@"
EOF

chmod +x $APP_DIR/run.sh
chown $SERVICE_USER:$SERVICE_USER $APP_DIR/run.sh

# Set up firewall
print_status "Configuring firewall..."
ufw --force enable
ufw allow ssh
ufw allow 'Nginx Full'

# Reload systemd
systemctl daemon-reload

print_status "✅ Deployment completed successfully!"
echo
echo "📋 Next Steps:"
echo "1. Edit configuration: sudo nano $APP_DIR/.env"
echo "2. Add OneDrive links: sudo nano $APP_DIR/links.txt"
echo "3. Test manually: sudo -u $SERVICE_USER $APP_DIR/run.sh --help"
echo "4. Enable service: sudo systemctl enable $APP_NAME"
echo "5. Start service: sudo systemctl start $APP_NAME"
echo "6. Check status: sudo systemctl status $APP_NAME"
echo "7. View logs: sudo journalctl -u $APP_NAME -f"
echo
echo "📁 Application installed in: $APP_DIR"
echo "👤 Running as user: $SERVICE_USER"
echo "📊 Logs location: $APP_DIR/logs/" 