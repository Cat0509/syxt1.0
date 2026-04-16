const bcrypt = require('bcrypt');
const fs = require('fs');
const h1 = bcrypt.hashSync('admin123', 10);
const h2 = bcrypt.hashSync('123456', 10);
const content = `ADMIN123_HASH=${h1}\n123456_HASH=${h2}`;
fs.writeFileSync('hashes.txt', content);
console.log('Hashes written to hashes.txt');
