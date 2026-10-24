const fs = require('fs').promises;
const path = require('path');
const tenantManager = require('./tenant-manager');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const TENANTS_DIR = path.join(DATA_DIR, 'tenants');
const METADATA_FILE = 'metadata.json';

class ProfileManager {
  _assertTenantId(tenantId) {
    if (typeof tenantId !== 'string' || !tenantId || tenantId.length > 200
      || tenantId.includes('/') || tenantId.includes('\\') || tenantId.includes('..') || tenantId.includes('\0')) {
      throw new Error('tenantId inválido (vazio, traversal ou longo demais)');
    }
  }

  async hasProfile(tenantId) {
    this._assertTenantId(tenantId);
    const masterDir = tenantManager.getProfileMasterDir(tenantId);
    try {
      await fs.access(masterDir);
      return true;
    } catch {
      return false;
    }
  }

  async loadMetadata(tenantId) {
    this._assertTenantId(tenantId);
    const metadataPath = path.join(TENANTS_DIR, tenantId, METADATA_FILE);
    let raw;
    try {
      raw = await fs.readFile(metadataPath, 'utf-8');
    } catch {
      return null; // ainda não existe — não é erro
    }
    try {
      return JSON.parse(raw);
    } catch {
      // JSON corrompido (crash no meio do write): arquiva p/ diagnóstico e recomeça,
      // em vez de mascarar como "sem metadata" e corromper de novo no próximo save.
      try {
        await fs.rename(metadataPath, `${metadataPath}.corrupt-${Date.now()}`);
      } catch {}
      console.warn(`[Profile] metadata.json corrompido (tenant ${String(tenantId).slice(0, 8)}...), arquivado; recomeçando do zero`);
      return null;
    }
  }

  async saveMetadata(tenantId, extra = {}) {
    this._assertTenantId(tenantId);
    const tenantDir = path.join(TENANTS_DIR, tenantId);
    await fs.mkdir(tenantDir, { recursive: true });
    const metadataPath = path.join(tenantDir, METADATA_FILE);
    // Read-modify-write: preserva campos que outro fluxo gravou (antes o save apagava tudo).
    let prev = {};
    try {
      prev = JSON.parse(await fs.readFile(metadataPath, 'utf-8'));
    } catch {}
    const metadata = {
      ...prev,
      tenantId,
      savedAt: new Date().toISOString(),
      version: '2.0',
      ...extra,
    };
    // Escrita atômica (tmp + rename): crash no meio nunca deixa meio-JSON no disco.
    const tmpPath = `${metadataPath}.tmp-${process.pid}`;
    await fs.writeFile(tmpPath, JSON.stringify(metadata, null, 2));
    await fs.rename(tmpPath, metadataPath);
  }

  async cleanProfile(tenantId) {
    this._assertTenantId(tenantId);
    const masterDir = tenantManager.getProfileMasterDir(tenantId);
    try {
      await fs.rm(masterDir, { recursive: true, force: true });
      console.log(`[Profile] Cleaned profile for tenant ${tenantId.slice(0, 8)}...`);
    } catch {}
  }

  getUserDataDir(tenantId) {
    this._assertTenantId(tenantId);
    return tenantManager.getSessionProfileDir(tenantId, '_default');
  }

  async saveSessionState(tenantId, displayNum) {
    this._assertTenantId(tenantId);
    await this.saveMetadata(tenantId, {
      lastDisplay: displayNum,
      lastActivity: new Date().toISOString(),
    });
  }
}

module.exports = new ProfileManager();
