// lambda/utils/cryptoUtil.js
// A shared utility for AES-256 encryption and decryption.

const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';
const SECRET_KEY = process.env.AES_SECRET_KEY;
const IV_LENGTH = 16; // For AES, this is always 16

// A 32-byte key is required for AES-256
if (!SECRET_KEY || SECRET_KEY.length !== 32) {
  throw new Error('A 32-byte AES_SECRET_KEY must be provided via environment variables.');
}

// Create a buffer from the secret key for the crypto functions
const keyBuffer = Buffer.from(SECRET_KEY, 'utf8');

/**
 * Encrypts a piece of plain text.
 * @param {string} text The plain text to encrypt.
 * @returns {string} The encrypted text, formatted as "iv:encryptedData" in hex.
 */
const encrypt = (text) => {
  // Generate a new, random Initialization Vector (IV) for each encryption.
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, keyBuffer, iv);
  
  // Encrypt the text
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  // Prepend the IV to the encrypted data (in hex) for use during decryption.
  // This is a standard and secure practice.
  return `${iv.toString('hex')}:${encrypted}`;
};

/**
 * Decrypts a piece of encrypted text.
 * @param {string} text The encrypted text (expected format: "iv:encryptedData" in hex).
 * @returns {string} The decrypted plain text.
 */
const decrypt = (text) => {
  try {
    const textParts = text.split(':');
    
    // The first part is the IV, the second is the encrypted data.
    const iv = Buffer.from(textParts.shift(), 'hex');
    const encryptedText = textParts.join(':');
    
    const decipher = crypto.createDecipheriv(ALGORITHM, keyBuffer, iv);
    
    // Decrypt the text
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    console.error("Decryption failed:", error);
    // Return null or throw an error, depending on how you want to handle failures.
    // Returning the original text might leak information.
    return null; 
  }
};

module.exports = {
  encrypt,
  decrypt,
};