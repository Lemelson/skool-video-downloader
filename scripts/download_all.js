require('dotenv').config();
const { execSync } = require('child_process');

const targetUrl = process.argv[2] || process.env.SKOOL_CLASSROOM_URL;

if (!targetUrl) {
  console.error('Usage: npm run download:all <course-or-classroom-url>');
  console.error('  or set SKOOL_CLASSROOM_URL in .env');
  process.exit(1);
}

try {
  console.log(`\n==================================================`);
  console.log(`[1/3] Fetching course structure for: ${targetUrl}`);
  console.log(`==================================================\n`);
  execSync(`node -r dotenv/config scripts/cdp_course_state.js "${targetUrl}"`, { stdio: 'inherit' });

  console.log(`\n==================================================`);
  console.log(`[2/3] Downloading lesson details & attached resources (PDFs/notes)...`);
  console.log(`==================================================\n`);
  execSync(`node -r dotenv/config scripts/cdp_download_lesson_details.js "${targetUrl}"`, { stdio: 'inherit' });

  console.log(`\n==================================================`);
  console.log(`[3/3] Downloading all course videos...`);
  console.log(`==================================================\n`);
  execSync(`python3 scripts/download_accessible_videos.py`, { stdio: 'inherit' });

  console.log(`\n==================================================`);
  console.log(`[SUCCESS] All course materials & videos downloaded successfully!`);
  console.log(`==================================================\n`);
} catch (err) {
  console.error(`\n[ERROR] An error occurred during download_all:`, err.message);
  process.exit(1);
}
