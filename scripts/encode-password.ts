const password = process.argv[2];

if (!password) {
  console.error("Usage: npx tsx scripts/encode-password.ts <password>");
  process.exit(1);
}

console.log(encodeURIComponent(password));
