const crypto = require('crypto');

/**
 * Generates a unique ID (UUID v4)
 * @returns {string} UUID
 */
function generateId() {
    return crypto.randomUUID();
}

/**
 * Generates a business-friendly order number
 * Format: [StorePrefix][YYYYMMDD][SequentialNumber]
 * Example: S1-20240401-0001
 * Note: To ensure full sequentiality, a database-backed counter or 
 * a high-precision timestamp/random suffix mix is often used.
 * For this phase, we use a combination of storeId, timestamp and short random.
 * 
 * @param {string} storeId The store ID
 * @returns {string} Standardized order number
 */
function generateOrderNo(storeId = 'S0') {
    const now = new Date();
    const dateStr = now.getFullYear().toString() + 
                    (now.getMonth() + 1).toString().padStart(2, '0') + 
                    now.getDate().toString().padStart(2, '0');
    
    // Using a 4-digit random number as a simple sequential placeholder
    // In a production system, this would come from a redis counter or DB sequence.
    const randomSuffix = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    
    // Clean storeId if it has prefixes like 's'
    const storePrefix = storeId.toUpperCase().startsWith('S') ? storeId.toUpperCase() : `S${storeId}`;
    
    return `${storePrefix}-${dateStr}-${randomSuffix}`;
}

module.exports = {
    generateId,
    generateOrderNo
};
