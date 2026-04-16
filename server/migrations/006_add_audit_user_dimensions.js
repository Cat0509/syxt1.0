module.exports = {
    up: async (db) => {
        // Use column_exists check for safety
        const [columns] = await db.execute('SHOW COLUMNS FROM audit_logs');
        const hasUserId = columns.some(c => c.Field === 'user_id');
        const hasUsername = columns.some(c => c.Field === 'username');

        if (!hasUserId) {
            await db.execute('ALTER TABLE audit_logs ADD COLUMN user_id VARCHAR(50) AFTER store_id');
        }
        if (!hasUsername) {
            await db.execute('ALTER TABLE audit_logs ADD COLUMN username VARCHAR(50) AFTER user_id');
        }
    },
    down: async (db) => {
        await db.execute('ALTER TABLE audit_logs DROP COLUMN user_id');
        await db.execute('ALTER TABLE audit_logs DROP COLUMN username');
    }
};
