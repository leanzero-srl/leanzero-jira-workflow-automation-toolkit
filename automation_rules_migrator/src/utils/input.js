/**
 * User input utility functions
 */

const readline = require('readline');

/**
 * Create readline interface for user input
 * @returns {readline.Interface} Readline interface
 */
function createReadlineInterface() {
    return readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
}

/**
 * Promisify readline question for async/await usage
 * @param {readline.Interface} rl - Readline interface
 * @param {string} questionText - Question to ask user
 * @returns {Promise<string>} User's answer
 */
function question(rl, questionText) {
    return new Promise((resolve) => {
        rl.question(questionText, (answer) => {
            resolve(answer);
        });
    });
}

/**
 * Ask user for confirmation (y/n)
 * @param {readline.Interface} rl - Readline interface
 * @param {string} questionText - Question to ask
 * @returns {Promise<boolean>} True if user confirms, false otherwise
 */
async function confirm(rl, questionText) {
    const answer = await question(rl, questionText);
    return ['y', 'yes'].includes(answer.trim().toLowerCase());
}

/**
 * Wait for user to press Enter
 * @param {readline.Interface} rl - Readline interface
 * @param {string} message - Message to display (default: "Press Enter to continue...")
 * @returns {Promise<void>}
 */
async function waitForEnter(rl, message = 'Press Enter to continue...') {
    await question(rl, message);
}

module.exports = {
    createReadlineInterface,
    question,
    confirm,
    waitForEnter
};
