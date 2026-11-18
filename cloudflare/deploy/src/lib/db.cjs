/**
 * Promise-based wrapper for sqlite3 db.run.
 * @param {object} db - Database instance from getDatabase()
 * @param {string} sql - SQL statement
 * @param {array} params - Query parameters
 * @returns {Promise<{ lastID: number, changes: number }>} Resolves with statement result (this) on success
 */
function runDb(db, sql, params) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

/**
 * Promise-based sqlite3 db.get (single row).
 * @returns {Promise<object | null>}
 */
function getRow(db, sql, params) {
    return new Promise((resolve, reject) => {
        db.get(sql, params || [], (err, row) => {
            if (err) reject(err);
            else resolve(row || null);
        });
    });
}

/**
 * Promise-based sqlite3 db.all.
 * @returns {Promise<object[]>}
 */
function allRows(db, sql, params) {
    return new Promise((resolve, reject) => {
        db.all(sql, params || [], (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
}

module.exports = { runDb, getRow, allRows };
