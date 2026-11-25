// Entry point untuk cPanel "Setup Node.js App" (Phusion Passenger) yang memuat file via require().
import('./src/server.js').catch((err) => {
  console.error(err);
  process.exit(1);
});
