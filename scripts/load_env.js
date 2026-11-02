// Loads the project-root .env (if any) into process.env without overriding
// variables that are already set. Leading "~" and $HOME / ${HOME} in values are
// expanded so the same .env works for the Node and Python scripts.
const os = require('os');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
const result = require('dotenv').config({ path: envPath, quiet: true });

const home = os.homedir();
for (const [key, value] of Object.entries(result.parsed || {})) {
  if (process.env[key] !== value) continue; // set outside .env, leave as is
  process.env[key] = value
    .replace(/^~(?=\/|$)/, home)
    .replace(/\$\{HOME\}|\$HOME\b/g, home);
}
