/**
 * Field Mapper: builds oldFieldId -> newFieldId mapping using collected field names.
 *
 * During --collect, field_mapping.json saves { fieldId: fieldName } from the source.
 * During --apply, this module resolves those names to IDs on the target instance.
 */

class FieldMapper {
  constructor(client, log, options = {}) {
    this.client = client;
    this.log = log || console.log;
    this._cache = new Map(); // fieldName -> resolved field or null
    // preferMigrated: try the "<name> (migrated)" variant before the exact name.
    // True is the DC→Cloud convention (default). Cloud→cloud copies want exact-name
    // matching only, so the applier passes preferMigrated:false.
    this.preferMigrated = options.preferMigrated !== false;
    // overrides: explicit { sourceFieldId: targetFieldId } forced mappings, applied
    // BEFORE name resolution. Use for cases where exact-name matching can't work —
    // e.g. a renamed/migrated source field whose target counterpart has a different
    // name ("Team (migrated)" cf_10150 -> "Team (Legacy)" cf_10238). Loaded by the
    // applier from cc_field_overrides.json in the collect dir.
    this.overrides = options.overrides || {};
  }

  /**
   * Build a complete remapping from source field IDs to target field IDs.
   *
   * @param {object} sourceFieldMapping - { "customfield_10001": "Story Points", ... }
   * @returns {object} { "customfield_10001": "customfield_20005", ... }
   *   Values are null for fields that could not be resolved on target.
   */
  async buildMapping(sourceFieldMapping) {
    const remapping = {};
    const entries = Object.entries(sourceFieldMapping);
    this.log(`  [FieldMapper] Resolving ${entries.length} custom fields on target...`);

    for (const [sourceId, fieldName] of entries) {
      // Explicit override wins over name resolution (and over a missing name).
      if (this.overrides[sourceId]) {
        remapping[sourceId] = this.overrides[sourceId];
        this.log(`  [FieldMapper] OVERRIDE: ${sourceId} ("${fieldName || "?"}") -> ${this.overrides[sourceId]}`);
        continue;
      }
      // Skip fields that couldn't be resolved during collect
      if (!fieldName) {
        remapping[sourceId] = null;
        this.log(`  [FieldMapper] WARNING: ${sourceId} had no name in source, cannot remap`);
        continue;
      }
      const targetId = await this.resolveFieldOnTarget(fieldName);
      remapping[sourceId] = targetId;

      if (targetId) {
        if (targetId !== sourceId) {
          this.log(`  [FieldMapper] ${sourceId} ("${fieldName}") -> ${targetId}`);
        }
      } else {
        this.log(`  [FieldMapper] WARNING: ${sourceId} ("${fieldName}") not found on target`);
      }
    }

    const resolved = Object.values(remapping).filter((v) => v !== null).length;
    const total = entries.length;
    this.log(
      `  [FieldMapper] Resolved ${resolved}/${total} fields (${total - resolved} unmapped)`,
    );

    return remapping;
  }

  /**
   * Look up a field by name on the target instance.
   * Checks "(migrated)" suffix first, then exact name.
   * Returns the field ID or null.
   */
  async resolveFieldOnTarget(fieldName) {
    if (this._cache.has(fieldName)) {
      return this._cache.get(fieldName);
    }

    let targetId = null;
    if (this.preferMigrated) {
      // Try "(migrated)" variant first (DC→Cloud naming convention).
      targetId = await this.searchExactField(fieldName + " (migrated)");
    }
    if (!targetId) {
      targetId = await this.searchExactField(fieldName);
    }

    this._cache.set(fieldName, targetId);
    return targetId;
  }

  /**
   * Search for a field by exact name on the target.
   * The API returns fuzzy matches, so we verify exact match.
   */
  async searchExactField(name) {
    try {
      const results = await this.client.searchFieldByName(name);
      for (const field of results) {
        if (field.name === name) {
          return field.id;
        }
      }
    } catch (err) {
      this.log(`  [FieldMapper] Error searching for "${name}": ${err.message}`);
    }
    return null;
  }
}

module.exports = FieldMapper;
