const fs = require('fs').promises;
const path = require('path');
const tenantManager = require('./tenant-manager');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const TENANTS_DIR = path.join(DATA_DIR, 'tenants');
const METADATA_FILE = 'metadata.json';

class ProfileManager {
  async hasProfile(tenantId) {
    const masterDir = tenantManager.getProfileMasterDir(tenantId);
    try {
      await fs.access(masterDir);
      return true;
    } catch {
      return false;
    }
  }

  async loadMetadata(tenantId) {
    const metadataPath = path.join(TENANTS_DIR, tenantId, METADATA_FILE);
    try {
      const data = await fs.readFile(metadataPath, 'utf-8');
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  async saveMetadata(tenantId, extra = {}) {
    const tenantDir = path.join(TENANTS_DIR, tenantId);
    await fs.mkdir(tenantDir, { recursive: true });
    const metadata = {
      tenantId,
      savedAt: new Date().toISOString(),
      version: '2.0',
      ...extra,
    };
    await fs.writeFile(
      path.join(tenantDir, METADATA_FILE),
      JSON.stringify(metadata, null, 2)
    );
  }

  async cleanProfile(tenantId) {
    const masterDir = tenantManager.getProfileMasterDir(tenantId);
    try {
      await fs.rm(masterDir, { recursive: true, force: true });
      console.log(`[Profile] Cleaned profile for tenant ${tenantId.slice(0, 8)}...`);
    } catch {}
  }

  getUserDataDir(tenantId) {
    return tenantManager.getSessionProfileDir(tenantId, '_default');
  }

  async saveSessionState(tenantId, displayNum) {
    await this.saveMetadata(tenantId, {
      lastDisplay: displayNum,
      lastActivity: new Date().toISOString(),
    });
  }
}

module.exports = new ProfileManager();
