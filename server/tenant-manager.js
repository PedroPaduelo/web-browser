const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const TENANTS_DIR = path.join(DATA_DIR, 'tenants');

const ESSENTIAL_FILES = [
  'Default/Cookies',
  'Default/Preferences',
  'Default/Bookmarks',
  'Default/Login Data',
  'Default/Web Data',
  'Local State',
];

function ensureTenantDir(tenantId) {
  const tenantDir = path.join(TENANTS_DIR, tenantId);
  fs.mkdirSync(path.join(tenantDir, 'profile-master', 'Default'), { recursive: true });
  fs.mkdirSync(path.join(tenantDir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(tenantDir, 'downloads'), { recursive: true });
  return tenantDir;
}

function getProfileMasterDir(tenantId) {
  return path.join(TENANTS_DIR, tenantId, 'profile-master');
}

function getSessionProfileDir(tenantId, sessionId) {
  return path.join(TENANTS_DIR, tenantId, 'sessions', sessionId, 'profile');
}

function copyProfileToSession(tenantId, sessionId) {
  const masterDir = getProfileMasterDir(tenantId);
  const sessionDir = getSessionProfileDir(tenantId, sessionId);
  fs.mkdirSync(path.join(sessionDir, 'Default'), { recursive: true });

  if (!fs.existsSync(masterDir)) {
    console.log(`[TenantMgr] No master profile for ${tenantId}, starting with clean profile`);
    return sessionDir;
  }

  for (const file of ESSENTIAL_FILES) {
    const src = path.join(masterDir, file);
    const dst = path.join(sessionDir, file);
    try {
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.cpSync(src, dst, { force: true });
      }
    } catch (err) {
      console.error(`[TenantMgr] Failed to copy ${file} for session ${sessionId}:`, err.message);
    }
  }

  console.log(`[TenantMgr] Copied master profile to session ${sessionId} (tenant: ${tenantId})`);
  return sessionDir;
}

function mergeProfileFromSession(tenantId, sessionId) {
  const masterDir = getProfileMasterDir(tenantId);
  const sessionDir = getSessionProfileDir(tenantId, sessionId);

  if (!fs.existsSync(sessionDir)) {
    console.log(`[TenantMgr] Session dir not found for merge: ${sessionId}`);
    return;
  }

  fs.mkdirSync(path.join(masterDir, 'Default'), { recursive: true });

  for (const file of ESSENTIAL_FILES) {
    const src = path.join(sessionDir, file);
    const dst = path.join(masterDir, file);
    try {
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.cpSync(src, dst, { force: true });
      }
    } catch (err) {
      console.error(`[TenantMgr] Failed to merge ${file} from session ${sessionId}:`, err.message);
    }
  }

  console.log(`[TenantMgr] Merged session ${sessionId} profile back to master (tenant: ${tenantId})`);
}

function cleanupSessionDir(tenantId, sessionId) {
  const sessionDir = path.join(TENANTS_DIR, tenantId, 'sessions', sessionId);
  try {
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      console.log(`[TenantMgr] Cleaned up session dir: ${sessionId}`);
    }
  } catch (err) {
    console.error(`[TenantMgr] Failed to cleanup session dir ${sessionId}:`, err.message);
  }
}

module.exports = {
  ensureTenantDir,
  getProfileMasterDir,
  getSessionProfileDir,
  copyProfileToSession,
  mergeProfileFromSession,
  cleanupSessionDir,
};
