#!/usr/bin/env node
/**
 * Server CLI for administrative tasks
 */

import { initDatabase, createUser, listUsers } from './db.js';

const args = process.argv.slice(2);
const command = args[0];

const db = initDatabase();

switch (command) {
  case 'create-user': {
    const nameIdx = args.indexOf('--name');
    if (nameIdx === -1 || !args[nameIdx + 1]) {
      console.error('Usage: create-user --name <username>');
      process.exit(1);
    }
    const name = args[nameIdx + 1];
    const { id, apiKey } = createUser(db, name);
    console.log(`User created successfully!`);
    console.log(`  ID:      ${id}`);
    console.log(`  Name:    ${name}`);
    console.log(`  API Key: ${apiKey}`);
    console.log(`\nSave this API key - it cannot be retrieved later!`);
    break;
  }

  case 'list-users': {
    const users = listUsers(db);
    if (users.length === 0) {
      console.log('No users found.');
    } else {
      console.log('Users:');
      for (const user of users) {
        console.log(`  - ${user.name} (${user.id}) - created ${user.createdAt}`);
      }
    }
    break;
  }

  default:
    console.log(`shared-things-server CLI

Commands:
  create-user --name <name>   Create a new user and generate API key
  list-users                  List all users
`);
}
