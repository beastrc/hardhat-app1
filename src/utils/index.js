const fs = require('fs');
const path = require('path');
const {transformNamedAccounts} = require('./eth');

let chainId;
async function getChainId(bre) {
  if (chainId) {
    return chainId;
  }
  try {
    chainId = await bre.ethereum.send('eth_chainId');
  } catch (e) {
    console.log('failed to get chainId, falling back on net_version...');
    chainId = await bre.ethereum.send('net_version');
  }

  if (chainId.startsWith('0x')) {
    chainId = '' + parseInt(chainId.slice(2), 16); // TODO better
  }

  return chainId;
}

function loadAllDeployments(deploymentsPath, onlyABIAndAddress) {
  const all = {};
  fs.readdirSync(deploymentsPath).forEach((name) => {
    const fPath = path.resolve(deploymentsPath, name);
    const stats = fs.statSync(fPath);
    if (stats.isDirectory()) {
      const contracts = loadDeployments(deploymentsPath, name, onlyABIAndAddress);
      all[name] = contracts;
    }
  });
  return all;
}

function loadDeployments(deploymentsPath, subPath, onlyABIAndAddress) {
  const contracts = {};
  const deployPath = path.join(deploymentsPath, subPath);
  let filesStats;
  try {
      filesStats = traverse(deployPath);
  } catch (e) {
      // console.log('no folder at ' + deployPath);
      return {};
  }
  let fileNames = filesStats.map(a => a.relativePath);
  fileNames = fileNames.sort((a, b) => {
      if (a < b) { return -1; }
      if (a > b) { return 1; }
      return 0;
  });
  
  for (const fileName of fileNames) {
    if (fileName.substr(fileName.length-5) == '.json') {
      const deploymentFileName = path.join(deployPath, fileName);
      let deployment = JSON.parse(fs.readFileSync(deploymentFileName).toString());
      if (onlyABIAndAddress) {
        deployment = {
          address: deployment.address,
          abi: deployment.abi
        };
      }
      const name = fileName.slice(0, fileName.length-5);
      // console.log('fetching ' + deploymentFileName + '  for ' + name);
      contracts[name] = deployment;
    }
  }
  return contracts;
}

function addDeployments(db, deploymentsPath, subPath) {
  const contracts = loadDeployments(deploymentsPath, subPath);
  for (const key of Object.keys(contracts)) {
    db.deployments[key] = contracts[key];
  }
}

function addNamedAccounts(bre, accounts, chainId) {
  if (bre.config.namedAccounts) {
    bre.namedAccounts = transformNamedAccounts(bre.config.namedAccounts, chainId, accounts, bre.network.name);
  } else {
    bre.namedAccounts = {};
  }
}


const traverse = function(dir, result = [], topDir, filter) {
    fs.readdirSync(dir).forEach((name) => {
        const fPath = path.resolve(dir, name);
        const stats = fs.statSync(fPath);
        if(!filter || filter(name, stats)) {
            const fileStats = { name, path: fPath, relativePath: path.relative(topDir || dir, fPath), mtimeMs: stats.mtimeMs, directory: stats.isDirectory() };
            if (fileStats.directory) {
                result.push(fileStats);
                return traverse(fPath, result, topDir || dir)
            }
            result.push(fileStats);
        }
    });
    return result;
};

module.exports = {
    traverse,
    getChainId,
    addDeployments,
    addNamedAccounts,
    loadAllDeployments,
}
