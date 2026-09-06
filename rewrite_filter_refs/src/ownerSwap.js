// Thin wrapper over cloudJiraClient.setFilterOwner. Keeps the state-machine
// code in filterProcessor readable and makes it trivial to mock in tests.

async function swapOwner(client, filterId, newAccountId) {
  return client.setFilterOwner(filterId, newAccountId);
}

async function restoreOwner(client, filterId, originalAccountId) {
  return client.setFilterOwner(filterId, originalAccountId);
}

module.exports = { swapOwner, restoreOwner };
