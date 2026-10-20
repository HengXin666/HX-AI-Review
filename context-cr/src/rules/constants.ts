// Literals owned by the rules engine; the L0 pipeline keeps its own in src/constants.ts.
export const EXEMPTION_FILE = ".hx-rules-exemptions.json";
export const RULES_REPORT_NAME = "rules";
export const RULES_PENDING_NAME = "rules-pending-review";
export const DIRECTORY_FILE_LIMIT = 6;
export const HEADER_COMMENT_LIMIT = 10;
export const WORKFLOW_DIR = ".github/workflows";

export const ENTRY_FILES = ["index.ts", "index.tsx", "index.js", "mod.ts", "__init__.py"];

/** Source extensions the import graph understands. */
export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"];

/** Directories whose files form the API layer of a module. */
export const API_DIRS = ["api", "service", "services", "domain", "usecase", "usecases"];

/** Packages that bind business logic to a concrete data source and must stay behind impl/. */
export const DATA_SOURCE_PACKAGES = [
    "pg",
    "pg-promise",
    "mysql",
    "mysql2",
    "better-sqlite3",
    "sqlite3",
    "mongoose",
    "mongodb",
    "redis",
    "ioredis",
    "prisma",
    "@prisma/client",
    "knex",
    "drizzle-orm",
    "sequelize",
    "typeorm",
    "@aws-sdk/",
    "axios",
    "node-fetch",
    "undici",
    "got",
];
