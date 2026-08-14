// Load .env so PrismaClient sees DATABASE_URL when jest runs the e2e suite.
import { config } from 'dotenv';

config();
