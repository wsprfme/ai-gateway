import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Root project, tidak bergantung pada working directory (penting di cPanel/Passenger).
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
