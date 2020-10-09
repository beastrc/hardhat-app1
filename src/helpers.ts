import { Signer } from "@ethersproject/abstract-signer";
import { Web3Provider, TransactionResponse } from "@ethersproject/providers";
import { getAddress } from "@ethersproject/address";
import {
  Contract,
  ContractFactory,
  PayableOverrides
} from "@ethersproject/contracts";
import { BigNumber } from "@ethersproject/bignumber";
import { Wallet } from "@ethersproject/wallet";
import {
  keccak256 as solidityKeccak256,
  keccak256
} from "@ethersproject/solidity";
import { zeroPad, hexlify } from "@ethersproject/bytes";
import { Interface, FunctionFragment } from "@ethersproject/abi";
import {
  BuidlerRuntimeEnvironment,
  Deployment,
  DeployResult,
  DeploymentsExtension,
  Artifact,
  DeployOptions,
  EthereumProvider,
  TxOptions,
  CallOptions,
  SimpleTx,
  Receipt,
  Execute,
  Address,
  DiamondOptions,
  LinkReferences,
  Create2DeployOptions,
  FacetCut
} from "@nomiclabs/buidler/types";
import { PartialExtension } from "./types";
import { UnknownSignerError } from "./errors";
import { mergeABIs } from "./utils";
import transparentProxy from "../artifacts/TransparentProxy.json";
import diamondBase from "../artifacts/Diamond.json";
import diamondCutFacet from "../artifacts/DiamondCutFacet.json";
import diamondLoupeFacet from "../artifacts/DiamondLoupeFacet.json";
import ownershipFacet from "../artifacts/OwnershipFacet.json";
import diamantaire from "../artifacts/Diamantaire.json";
import fs from "fs";
import path from "path";

diamondBase.abi = mergeABIs(
  false,
  diamondBase.abi,
  diamondCutFacet.abi,
  diamondLoupeFacet.abi,
  ownershipFacet.abi
);

function fixProvider(providerGiven: any): any {
  // alow it to be used by ethers without any change
  if (providerGiven.sendAsync === undefined) {
    providerGiven.sendAsync = (
      req: {
        id: number;
        jsonrpc: string;
        method: string;
        params: any[];
      },
      callback: (error: any, result: any) => void
    ) => {
      providerGiven
        .send(req.method, req.params)
        .then((result: any) =>
          callback(null, { result, id: req.id, jsonrpc: req.jsonrpc })
        )
        .catch((error: any) => callback(error, null));
    };
  }
  return providerGiven;
}

function findAll(toFind: string[], array: string[]): boolean {
  for (const f of toFind) {
    if (array.indexOf(f) === -1) {
      return false;
    }
  }
  return true;
}

function linkRawLibrary(
  bytecode: string,
  libraryName: string,
  libraryAddress: string
): string {
  const address = libraryAddress.replace("0x", "");
  let encodedLibraryName;
  if (libraryName.startsWith("$") && libraryName.endsWith("$")) {
    encodedLibraryName = libraryName.slice(1, libraryName.length - 1);
  } else {
    encodedLibraryName = solidityKeccak256(["string"], [libraryName]).slice(
      2,
      36
    );
  }
  const pattern = new RegExp(`_+\\$${encodedLibraryName}\\$_+`, "g");
  if (!pattern.exec(bytecode)) {
    throw new Error(
      `Can't link '${libraryName}' (${encodedLibraryName}) in \n----\n ${bytecode}\n----\n`
    );
  }
  return bytecode.replace(pattern, address);
}

function linkRawLibraries(
  bytecode: string,
  libraries: { [libraryName: string]: Address }
): string {
  for (const libName of Object.keys(libraries)) {
    const libAddress = libraries[libName];
    bytecode = linkRawLibrary(bytecode, libName, libAddress);
  }
  return bytecode;
}

function linkLibraries(
  artifact: {
    bytecode: string;
    linkReferences?: {
      [libraryFileName: string]: {
        [libraryName: string]: Array<{ length: number; start: number }>;
      };
    };
  },
  libraries?: { [libraryName: string]: Address }
) {
  let bytecode = artifact.bytecode;

  if (libraries) {
    if (artifact.linkReferences) {
      for (const [fileName, fileReferences] of Object.entries(
        artifact.linkReferences
      )) {
        for (const [libName, fixups] of Object.entries(fileReferences)) {
          const addr = libraries[libName];
          if (addr === undefined) {
            continue;
          }

          for (const fixup of fixups) {
            bytecode =
              bytecode.substr(0, 2 + fixup.start * 2) +
              addr.substr(2) +
              bytecode.substr(2 + (fixup.start + fixup.length) * 2);
          }
        }
      }
    } else {
      bytecode = linkRawLibraries(bytecode, libraries);
    }
  }

  // TODO return libraries object with path name <filepath.sol>:<name> for names

  return bytecode;
}
let solcInput: string;
let solcInputHash: string;
let solcOutput: {
  contracts: {
    [filename: string]: {
      [contractName: string]: {
        abi: any[];
        metadata?: string;
        devdoc?: any;
        userdoc?: any;
        storageLayout?: any;
        methodIdentifiers?: any;
        evm?: any; // TODO
      };
    };
  };
  sources: { [filename: string]: any };
};
let provider: Web3Provider;
const availableAccounts: { [name: string]: boolean } = {};
export function addHelpers(
  env: BuidlerRuntimeEnvironment,
  partialExtension: PartialExtension, // TODO
  getArtifact: (name: string) => Promise<Artifact>,
  onPendingTx: (
    txResponse: TransactionResponse,
    name?: string,
    data?: any
  ) => Promise<TransactionResponse>,
  getGasPrice: () => Promise<BigNumber | undefined>,
  log: (...args: any[]) => void,
  print: (msg: string) => void
): DeploymentsExtension {
  async function init() {
    if (!provider) {
      provider = new Web3Provider(fixProvider(env.ethereum));
      try {
        const accounts = await provider.send("eth_accounts", []);
        for (const account of accounts) {
          availableAccounts[account.toLowerCase()] = true;
        }
      } catch (e) {}
      // TODO wait for buidler to have the info in artifact
      try {
        solcOutput = JSON.parse(
          fs
            .readFileSync(path.join(env.config.paths.cache, "solc-output.json"))
            .toString()
        );
      } catch (e) {}

      // Necessary for etherscan it seems. using metadata seems insuficient to reconstruct the necessary info for etherscan. Here is a diff of a success vs failure case: https://gist.github.com/wighawag/dfc123ffb7838e5aeb88f58abff505f7
      try {
        solcInput = fs
          .readFileSync(path.join(env.config.paths.cache, "solc-input.json"))
          .toString();
      } catch (e) {}
      if (solcInput) {
        solcInputHash = keccak256(["string"], [solcInput]);
      }
    }
  }

  async function setupGasPrice(overrides: any) {
    if (!overrides.gasPrice) {
      overrides.gasPrice = await getGasPrice();
    }
  }

  async function overrideGasLimit(
    overrides: any,
    options: {
      estimatedGasLimit?: number | BigNumber | string;
      estimateGasExtra?: number | BigNumber | string;
    },
    estimate: (overrides: any) => Promise<BigNumber>
  ) {
    const estimatedGasLimit = options.estimatedGasLimit
      ? BigNumber.from(options.estimatedGasLimit).toNumber()
      : undefined;
    const estimateGasExtra = options.estimateGasExtra
      ? BigNumber.from(options.estimateGasExtra).toNumber()
      : undefined;
    if (!overrides.gasLimit) {
      overrides.gasLimit = estimatedGasLimit;
      overrides.gasLimit = (await estimate(overrides)).toNumber();
      if (estimateGasExtra) {
        overrides.gasLimit = overrides.gasLimit + estimateGasExtra;
        if (estimatedGasLimit) {
          overrides.gasLimit = Math.min(overrides.gasLimit, estimatedGasLimit);
        }
      }
    }
  }

  function getCreate2Address(
    create2DeployerAddress: Address,
    salt: string,
    bytecode: string
  ): Address {
    return getAddress(
      "0x" +
        solidityKeccak256(
          ["bytes"],
          [
            `0xff${create2DeployerAddress.slice(2)}${salt.slice(
              2
            )}${solidityKeccak256(["bytes"], [bytecode]).slice(2)}`
          ]
        ).slice(-40)
    );
  }

  async function ensureCreate2DeployerReady(options: {
    from: string;
    log?: boolean;
  }): Promise<string> {
    const { address: from, ethersSigner } = getFrom(options.from);
    if (!ethersSigner) {
      throw new Error("no signer for " + from);
    }
    const create2DeployerAddress = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
    const code = await provider.getCode(create2DeployerAddress);
    if (code === "0x") {
      const senderAddress = "0x3fab184622dc19b6109349b94811493bf2a45362";
      if (options.log) {
        log(
          `sending eth to create2 contract deployer address (${senderAddress})...`
        );
      }
      // TODO gasPrice override
      await ethersSigner.sendTransaction({
        to: senderAddress,
        value: BigNumber.from("10000000000000000").toHexString()
      });
      // await provider.send("eth_sendTransaction", [{
      //   from
      // }]);
      if (options.log) {
        log(
          `deploying create2 deployer contract (at ${create2DeployerAddress}) using deterministic deployment (https://github.com/Arachnid/deterministic-deployment-proxy)...`
        );
      }
      await provider.sendTransaction(
        "0xf8a58085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf31ba02222222222222222222222222222222222222222222222222222222222222222a02222222222222222222222222222222222222222222222222222222222222222"
      );
    }
    return create2DeployerAddress;
  }

  async function getArtifactFromOptions(
    name: string,
    options: DeployOptions
  ): Promise<{
    artifact: {
      abi: any;
      bytecode: string;
      deployedBytecode?: string;
      deployedLinkReferences?: LinkReferences;
      linkReferences?: LinkReferences;
    };
    contractName?: string;
  }> {
    let artifact: { abi: any; bytecode: string; deployedBytecode?: string };
    let contractName: string | undefined;
    if (options.contract) {
      if (typeof options.contract === "string") {
        contractName = options.contract;
        artifact = await getArtifact(options.contract);
      } else {
        artifact = options.contract;
      }
    } else {
      contractName = name;
      artifact = await getArtifact(name);
    }
    return { artifact, contractName };
  }

  async function getArtifactInfo(
    name: string,
    options: DeployOptions
  ): Promise<{
    abi: any[];
    byteCode: string;
    contractSolcOutput?: {
      metadata?: string;
      methodIdentifiers?: any;
      storageLayout?: any;
      userdoc?: any;
      devdoc?: any;
      evm?: any;
    };
    artifact: {
      abi: any;
      bytecode: string;
      deployedBytecode?: string;
      deployedLinkReferences?: LinkReferences;
      linkReferences?: LinkReferences;
    };
  }> {
    const artifactInfo = await getArtifactFromOptions(name, options);
    const { artifact } = artifactInfo;
    const { contractName } = artifactInfo;
    const abi = artifact.abi;
    const byteCode = linkLibraries(artifact, options.libraries);

    let contractSolcOutput;
    if (!contractName) {
      if (typeof options.contract === "object") {
        contractSolcOutput = {
          metadata: options.contract?.metadata,
          methodIdentifiers: options.contract?.methodIdentifiers,
          storageLayout: options.contract?.storageLayout,
          userdoc: options.contract?.userdoc,
          devdoc: options.contract?.devdoc,
          evm: {
            gasEstimates: options.contract?.gasEstimates
          }
        };
      }
      if (!contractSolcOutput || !contractSolcOutput.metadata) {
        log(
          `no metadata associated with contract deployed as ${name}, the contract object should include a metadata field`
        );
      }
    } else {
      // TODO wait for buidler v2 // then we can hard fails on missing metadata
      // if (artifact.metadata) {
      //   contractSolcOutput = {
      //     metadata: artifact.metadata,
      //     methodIdentifiers: artifact.methodIdentifiers,
      //     storageLayout: artifact.storageLayout,
      //     userdoc: artifact.userdoc,
      //     devdoc: artifact.devdoc,
      //     evm: {
      //       gasEstimates: artifact.gasEstimates
      //     }
      //   };
      // } else
      if (solcOutput) {
        for (const fileEntry of Object.entries(solcOutput.contracts)) {
          for (const contractEntry of Object.entries(fileEntry[1])) {
            if (contractEntry[0] === contractName) {
              if (
                artifact.bytecode ===
                "0x" + contractEntry[1].evm?.bytecode?.object
              ) {
                contractSolcOutput = contractEntry[1];
              }
            }
          }
        }
      } else {
        log(
          `solc-output not found, it is not possible to get the metadata for ${name}. Check if the contract code exists (or if the artifacts belong to older contracts)`
        );
      }
    }
    return { abi, contractSolcOutput, byteCode, artifact };
  }

  async function _deploy(
    name: string,
    options: DeployOptions
  ): Promise<DeployResult> {
    const args: any[] = options.args ? [...options.args] : [];
    await init();
    const { address: from, ethersSigner } = getFrom(options.from);
    if (!ethersSigner) {
      throw new Error("no signer for " + from);
    }

    const {
      abi,
      contractSolcOutput,
      byteCode,
      artifact
    } = await getArtifactInfo(name, options);

    const overrides: PayableOverrides = {
      gasLimit: options.gasLimit,
      gasPrice: options.gasPrice,
      value: options.value,
      nonce: options.nonce
    };

    const factory = new ContractFactory(abi, byteCode, ethersSigner);
    const numArguments = factory.interface.deploy.inputs.length;
    if (args.length !== numArguments) {
      throw new Error(
        `expected ${numArguments} constructor arguments, got ${args.length}`
      );
    }
    const unsignedTx = factory.getDeployTransaction(...args, overrides);

    let create2Address;
    if (options.deterministicDeployment) {
      if (typeof unsignedTx.data === "string") {
        const create2DeployerAddress = await ensureCreate2DeployerReady(
          options
        );
        const create2Salt =
          typeof options.deterministicDeployment === "string"
            ? hexlify(zeroPad(options.deterministicDeployment, 32))
            : "0x0000000000000000000000000000000000000000000000000000000000000000";
        create2Address = getCreate2Address(
          create2DeployerAddress,
          create2Salt,
          unsignedTx.data
        );
        unsignedTx.to = create2DeployerAddress;

        unsignedTx.data = create2Salt + unsignedTx.data.slice(2);
      } else {
        throw new Error("unsigned tx data as bytes not supported");
      }
    }

    await overrideGasLimit(unsignedTx, options, newOverrides =>
      ethersSigner.estimateGas(newOverrides)
    );
    await setupGasPrice(unsignedTx);
    let tx = await ethersSigner.sendTransaction(unsignedTx);

    // await overrideGasLimit(overrides, options, newOverrides =>
    //   ethersSigner.estimateGas(newOverrides)
    // );
    // await setupGasPrice(overrides);
    // console.log({ args, overrides });
    // const ethersContract = await factory.deploy(...args, overrides);
    // let tx = ethersContract.deployTransaction;

    if (options.dev_forceMine) {
      try {
        await provider.send("evm_mine", []);
      } catch (e) {}
    }

    // const extendedAtifact = artifact as any; // TODO future version of buidler will hopefully have that info
    const preDeployment = {
      abi,
      args,
      linkedData: options.linkedData,
      solcInputHash,
      solcInput,
      metadata: contractSolcOutput?.metadata,
      bytecode: artifact.bytecode,
      deployedBytecode: artifact.deployedBytecode,
      libraries: options.libraries,
      userdoc: contractSolcOutput?.userdoc,
      devdoc: contractSolcOutput?.devdoc,
      methodIdentifiers: contractSolcOutput?.methodIdentifiers,
      storageLayout: contractSolcOutput?.storageLayout,
      gasEstimates: contractSolcOutput?.evm?.gasEstimates
    };
    tx = await onPendingTx(tx, name, preDeployment);
    const receipt = await tx.wait();
    const address =
      options.deterministicDeployment && create2Address
        ? create2Address
        : receipt.contractAddress;
    const deployment = {
      ...preDeployment,
      address,
      receipt,
      transactionHash: receipt.transactionHash
    };
    await env.deployments.save(name, deployment);
    return {
      ...deployment,
      address,
      newlyDeployed: true
    };
  }

  async function deterministic(
    name: string,
    options: Create2DeployOptions
  ): Promise<{
    address: Address;
    deploy: () => Promise<DeployResult>;
  }> {
    // TODO refactor to share that code:
    const args: any[] = options.args ? [...options.args] : [];
    await init();
    const { address: from, ethersSigner } = getFrom(options.from);
    if (!ethersSigner) {
      throw new Error("no signer for " + from);
    }
    const artifactInfo = await getArtifactFromOptions(name, options);
    const { artifact } = artifactInfo;
    const abi = artifact.abi;
    const byteCode = linkLibraries(artifact, options.libraries);
    const factory = new ContractFactory(abi, byteCode, ethersSigner);

    const numArguments = factory.interface.deploy.inputs.length;
    if (args.length !== numArguments) {
      throw new Error(
        `expected ${numArguments} constructor arguments, got ${args.length}`
      );
    }

    const overrides: PayableOverrides = {
      gasLimit: options.gasLimit,
      gasPrice: options.gasPrice,
      value: options.value,
      nonce: options.nonce
    };

    const unsignedTx = factory.getDeployTransaction(...args, overrides);

    if (typeof unsignedTx.data !== "string") {
      throw new Error("unsigned tx data as bytes not supported");
    } else {
      return {
        address: getCreate2Address(
          "0x4e59b44847b379578588920ca78fbf26c0b4956c",
          options.salt
            ? hexlify(zeroPad(options.salt, 32))
            : "0x0000000000000000000000000000000000000000000000000000000000000000",
          unsignedTx.data
        ),
        deploy: () =>
          deploy(name, {
            ...options,
            deterministicDeployment: options.salt || true
          })
      };
    }
  }

  function getDeployment(name: string): Promise<Deployment> {
    return env.deployments.get(name);
  }

  function getDeploymentOrNUll(name: string): Promise<Deployment | null> {
    return env.deployments.getOrNull(name);
  }

  async function fetchIfDifferent(
    name: string,
    options: DeployOptions
  ): Promise<{ differences: boolean; address?: string }> {
    const argArray = options.args ? [...options.args] : [];
    await init();

    if (options.deterministicDeployment) {
      // TODO remove duplication:
      const { address: from, ethersSigner } = getFrom(options.from);
      if (!ethersSigner) {
        throw new Error("no signer for " + from);
      }
      const artifactInfo = await getArtifactFromOptions(name, options);
      const { artifact } = artifactInfo;
      const { contractName } = artifactInfo;
      const abi = artifact.abi;
      const byteCode = linkLibraries(artifact, options.libraries);
      const factory = new ContractFactory(abi, byteCode, ethersSigner);

      const numArguments = factory.interface.deploy.inputs.length;
      if (argArray.length !== numArguments) {
        throw new Error(
          `expected ${numArguments} constructor arguments, got ${argArray.length}`
        );
      }

      const overrides: PayableOverrides = {
        gasLimit: options.gasLimit,
        gasPrice: options.gasPrice,
        value: options.value,
        nonce: options.nonce
      };

      const unsignedTx = factory.getDeployTransaction(...argArray, overrides);
      if (typeof unsignedTx.data === "string") {
        const create2Salt =
          typeof options.deterministicDeployment === "string"
            ? hexlify(zeroPad(options.deterministicDeployment, 32))
            : "0x0000000000000000000000000000000000000000000000000000000000000000";
        const create2DeployerAddress =
          "0x4e59b44847b379578588920ca78fbf26c0b4956c";
        const create2Address = getCreate2Address(
          create2DeployerAddress,
          create2Salt,
          unsignedTx.data
        );
        const code = await provider.getCode(create2Address);
        if (code === "0x") {
          return { differences: true, address: undefined };
        } else {
          return { differences: false, address: create2Address };
        }
      } else {
        throw new Error("unsigned tx data as bytes not supported");
      }
    }
    const fieldsToCompareArray =
      typeof options.fieldsToCompare === "string"
        ? [options.fieldsToCompare]
        : options.fieldsToCompare || [];
    const deployment = await env.deployments.getOrNull(name);
    if (deployment) {
      if (options.skipIfAlreadyDeployed) {
        return { differences: false, address: undefined }; // TODO check receipt, see below
      }
      // TODO transactionReceipt + check for status
      let transaction;
      if (deployment.receipt) {
        transaction = await provider.getTransaction(
          deployment.receipt.transactionHash
        );
      } else if (deployment.transactionHash) {
        transaction = await provider.getTransaction(deployment.transactionHash);
      }

      if (transaction) {
        const { artifact } = await getArtifactFromOptions(name, options);
        const abi = artifact.abi;
        const byteCode = linkLibraries(artifact, options.libraries);
        const factory = new ContractFactory(
          abi,
          byteCode,
          provider.getSigner(options.from)
        );

        const compareOnData = fieldsToCompareArray.indexOf("data") !== -1;

        let data;
        if (compareOnData) {
          const deployStruct = factory.getDeployTransaction(...argArray);
          data = deployStruct.data;
        }
        const newTransaction = {
          data: compareOnData ? data : undefined,
          gasLimit: options.gasLimit,
          gasPrice: options.gasPrice,
          value: options.value,
          from: options.from
        };

        transaction.data = transaction.data;
        for (const field of fieldsToCompareArray) {
          if (typeof (newTransaction as any)[field] === "undefined") {
            throw new Error(
              "field " +
                field +
                " not specified in new transaction, cant compare"
            );
          }
          if ((transaction as any)[field] !== (newTransaction as any)[field]) {
            return { differences: true, address: deployment.address };
          }
        }
        return { differences: false, address: deployment.address };
      }
    }
    return { differences: true, address: undefined };
  }

  async function _deployOne(
    name: string,
    options: DeployOptions
  ): Promise<DeployResult> {
    const argsArray = options.args ? [...options.args] : [];
    options = { ...options, args: argsArray };
    if (options.fieldsToCompare === undefined) {
      options.fieldsToCompare = ["data"];
    }
    let result: DeployResult;
    if (options.fieldsToCompare) {
      const diffResult = await fetchIfDifferent(name, options);
      if (diffResult.differences) {
        result = await _deploy(name, options);
      } else {
        const deployment = await getDeploymentOrNUll(name);
        if (deployment) {
          result = deployment as DeployResult;
        } else {
          if (!diffResult.address) {
            throw new Error(
              "no differences found but no address, this should be impossible"
            );
          }

          const { abi, contractSolcOutput, artifact } = await getArtifactInfo(
            name,
            options
          );

          // receipt missing
          const newDeployment = {
            abi,
            address: diffResult.address,
            linkedData: options.linkedData,
            solcInputHash,
            solcInput,
            metadata: contractSolcOutput?.metadata,
            bytecode: artifact.bytecode,
            deployedBytecode: artifact.deployedBytecode,
            libraries: options.libraries,
            userdoc: contractSolcOutput?.userdoc,
            devdoc: contractSolcOutput?.devdoc,
            methodIdentifiers: contractSolcOutput?.methodIdentifiers,
            storageLayout: contractSolcOutput?.storageLayout,
            gasEstimates: contractSolcOutput?.evm?.gasEstimates
          };
          await env.deployments.save(name, newDeployment);
          result = {
            ...newDeployment,
            newlyDeployed: false
          };
        }
      }
    } else {
      result = await _deploy(name, options);
    }
    if (options.log) {
      if (result.newlyDeployed) {
        log(
          `"${name}" deployed at ${result.address} with ${result.receipt?.gasUsed} gas`
        );
      } else {
        log(`reusing "${name}" at ${result.address}`);
      }
    }
    return result;
  }

  function _checkUpgradeIndex(
    oldDeployment: Deployment | null,
    upgradeIndex?: number
  ): DeployResult | undefined {
    if (typeof upgradeIndex === "undefined") {
      return;
    }
    if (upgradeIndex === 0) {
      if (oldDeployment) {
        return { ...oldDeployment, newlyDeployed: false };
      }
    } else if (upgradeIndex === 1) {
      if (!oldDeployment) {
        throw new Error(
          "upgradeIndex === 1 : expects Deployments to already exists"
        );
      }
      if (oldDeployment.history && oldDeployment.history.length > 0) {
        return { ...oldDeployment, newlyDeployed: false };
      }
    } else {
      if (!oldDeployment) {
        throw new Error(
          `upgradeIndex === ${upgradeIndex} : expects Deployments to already exists`
        );
      }
      if (!oldDeployment.history) {
        throw new Error(
          `upgradeIndex > 1 : expects Deployments history to exists`
        );
      } else if (oldDeployment.history.length > upgradeIndex - 1) {
        return { ...oldDeployment, newlyDeployed: false };
      } else if (oldDeployment.history.length < upgradeIndex - 1) {
        throw new Error(
          `upgradeIndex === ${upgradeIndex} : expects Deployments history length to be at least ${upgradeIndex -
            1}`
        );
      }
    }
  }

  async function _deployViaTransparentProxy(
    name: string,
    options: DeployOptions
  ): Promise<DeployResult> {
    const oldDeployment = await getDeploymentOrNUll(name);
    let updateMethod;
    let upgradeIndex;
    if (typeof options.proxy === "object") {
      upgradeIndex = options.proxy.upgradeIndex;
      updateMethod = options.proxy.methodName;
    } else if (typeof options.proxy === "string") {
      updateMethod = options.proxy;
    }
    const deployResult = _checkUpgradeIndex(oldDeployment, upgradeIndex);
    if (deployResult) {
      return deployResult;
    }
    const proxyName = name + "_Proxy";
    const { address: owner } = getProxyOwner(options);
    const argsArray = options.args ? [...options.args] : [];

    // --- Implementation Deployment ---
    const implementationName = name + "_Implementation";
    const implementationOptions = { ...options };
    delete implementationOptions.proxy;
    if (!implementationOptions.contract) {
      implementationOptions.contract = name;
    }
    const { artifact } = await getArtifactFromOptions(
      implementationName,
      implementationOptions
    );

    // ensure no clash
    mergeABIs(true, transparentProxy.abi, artifact.abi);

    const constructor = artifact.abi.find(
      (fragment: { type: string; inputs: any[] }) =>
        fragment.type === "constructor"
    );
    if (!constructor || constructor.inputs.length !== argsArray.length) {
      delete implementationOptions.args;
      if (constructor && constructor.inputs.length > 0) {
        throw new Error(
          `Proxy based contract constructor can only have either zero argument or the exact same argument as the method used for postUpgrade actions ${
            updateMethod ? "(" + updateMethod + "}" : ""
          }.
Plus they are only used when the contract is meant to be used as standalone when development ends.
`
        );
      }
    }
    const implementation = await _deployOne(
      implementationName,
      implementationOptions
    );
    // --- --------------------------- ---

    if (implementation.newlyDeployed) {
      // console.log(`implementation deployed at ${implementation.address} for ${implementation.receipt.gasUsed}`);
      const implementationContract = new Contract(
        implementation.address,
        implementation.abi
      );

      let data = "0x";
      if (updateMethod) {
        if (!implementationContract[updateMethod]) {
          throw new Error(
            `contract need to implement function ${updateMethod}`
          );
        }
        const txData = await implementationContract.populateTransaction[
          updateMethod
        ](...argsArray);
        data = txData.data || "0x";
      }

      let proxy = await getDeploymentOrNUll(proxyName);
      if (!proxy) {
        const proxyOptions = { ...options };
        delete proxyOptions.proxy;
        proxyOptions.contract = transparentProxy;
        proxyOptions.args = [implementation.address, data, owner];
        proxy = await _deployOne(proxyName, proxyOptions);
        // console.log(`proxy deployed at ${proxy.address} for ${proxy.receipt.gasUsed}`);
      } else {
        const currentOwner = await read(
          proxyName,
          { ...options },
          "proxyAdmin"
        );

        // let currentOwner;
        // try {
        //   currentOwner = await provider.getStorageAt(
        //     proxy.address,
        //     "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6102"
        //   );
        //   console.log({ currentOwner });
        // } catch (e) {
        //   console.error(e);
        // }

        if (currentOwner.toLowerCase() !== owner.toLowerCase()) {
          throw new Error(
            "To change owner, you need to call `transferOwnership`"
          );
        }
        const executeReceipt = await execute(
          proxyName,
          { ...options },
          "changeImplementation",
          implementation.address,
          data
        );
        if (!executeReceipt) {
          throw new Error("could not execute `changeImplementation`");
        }
      }
      const proxiedDeployment = {
        ...implementation,
        address: proxy.address,
        execute: updateMethod
          ? {
              methodName: updateMethod,
              args: argsArray
            }
          : undefined
      };
      if (oldDeployment) {
        proxiedDeployment.history = proxiedDeployment.history
          ? proxiedDeployment.history.concat([oldDeployment])
          : [oldDeployment];
      }
      await env.deployments.save(name, proxiedDeployment);

      const deployment = await env.deployments.get(name);
      return {
        ...deployment,
        newlyDeployed: true
      };
    } else {
      const deployment = await env.deployments.get(name);
      return {
        ...deployment,
        newlyDeployed: false
      };
    }
  }

  function getProxyOwner(options: DeployOptions) {
    let address = options.from; // admim default to msg.sender
    if (typeof options.proxy === "object") {
      address = options.proxy.owner || address;
    }
    return getFrom(address);
  }

  function getOptionalFrom(
    from?: string
  ): { address?: Address; ethersSigner?: Signer } {
    return _getFrom(from, true);
  }

  function getFrom(from?: string): { address: Address; ethersSigner?: Signer } {
    return _getFrom(from, false) as { address: Address; ethersSigner?: Signer };
  }

  function _getFrom(
    from?: string,
    optional?: boolean
  ): { address?: Address; ethersSigner?: Signer } {
    let ethersSigner: Signer | undefined;
    if (!from) {
      if (optional) {
        return {};
      }
      throw new Error("no from specified");
    }
    if (from.length >= 64) {
      if (from.length === 64) {
        from = "0x" + from;
      }
      const wallet = new Wallet(from);
      from = wallet.address;
      ethersSigner = wallet;
    } else {
      if (availableAccounts[from.toLowerCase()]) {
        ethersSigner = provider.getSigner(from);
      }
    }

    return { address: from, ethersSigner };
  }

  async function findEvents(
    contract: Contract,
    event: string,
    blockHash: string
  ): Promise<any[]> {
    // TODO type the return type
    const filter = contract.filters[event]();
    const events = await contract.queryFilter(filter, blockHash);
    return events;
  }

  function sigsFromABI(abi: any[]): string[] {
    return abi
      .filter((fragment: any) => fragment.type === "function")
      .map((fragment: any) =>
        Interface.getSighash(FunctionFragment.from(fragment))
      );
  }

  async function _deployViaDiamondProxy(
    name: string,
    options: DiamondOptions
  ): Promise<DeployResult> {
    const oldDeployment = await getDeploymentOrNUll(name);
    let proxy;
    const deployResult = _checkUpgradeIndex(
      oldDeployment,
      options.upgradeIndex
    );
    if (deployResult) {
      return deployResult;
    }

    const proxyName = name + "_DiamondProxy";
    const { address: owner, ethersSigner: ownerSigner } = getProxyOwner(
      options
    );
    const facetSnapshot: FacetCut[] = [];
    const oldFacets: FacetCut[] = [];
    if (oldDeployment) {
      proxy = await getDeployment(proxyName);
      const diamondProxy = new Contract(proxy.address, proxy.abi, provider);

      const currentFacetCuts: FacetCut[] = await diamondProxy.facets();
      for (const currentFacetCut of currentFacetCuts) {
        oldFacets.push(currentFacetCut);

        // ensure DiamondLoupeFacet, OwnershipFacet and DiamondCutFacet are kept // TODO options to delete cut them out?
        if (
          findAll(
            [
              "0xcdffacc6",
              "0x52ef6b2c",
              "0xadfca15e",
              "0x7a0ed627",
              "0x01ffc9a7"
            ],
            currentFacetCut.functionSelectors
          ) || // Loupe
          currentFacetCut.functionSelectors[0] === "e712b4e1" || // DiamoncCut
          findAll(
            ["0xf2fde38b", "0x8da5cb5b"],
            currentFacetCut.functionSelectors
          ) // ERC173
        ) {
          facetSnapshot.push(currentFacetCut);
        }
      }
    }
    // console.log({ oldFacets: JSON.stringify(oldFacets, null, "  ") });

    let changesDetected = !oldDeployment;
    let abi: any[] = diamondBase.abi.concat([]);
    const facetCuts: FacetCut[] = [];
    for (const facet of options.facets) {
      const artifact = await getArtifact(facet); // TODO getArtifactFromOptions( // allowing to pass bytecode / abi
      const constructor = artifact.abi.find(
        (fragment: { type: string; inputs: any[] }) =>
          fragment.type === "constructor"
      );
      if (constructor) {
        throw new Error(`Facet must not have a constructor`);
      }
      abi = mergeABIs(true, abi, artifact.abi);
      // TODO allow facet to be named so multiple version could coexist
      const implementation = await _deployOne(facet, {
        from: options.from,
        log: options.log,
        libraries: options.libraries
      });
      if (implementation.newlyDeployed) {
        // console.log(`facet ${facet} deployed at ${implementation.address}`);
        changesDetected = true;
        const facetCut = {
          facetAddress: implementation.address,
          functionSelectors: sigsFromABI(implementation.abi)
        };
        facetCuts.push(facetCut);
        facetSnapshot.push(facetCut);
      } else {
        const oldImpl = await getDeployment(facet);
        const facetCut = {
          facetAddress: oldImpl.address,
          functionSelectors: sigsFromABI(oldImpl.abi)
        };
        facetSnapshot.push(facetCut);
        if (
          !oldFacets.find(
            f => f.facetAddress.toLowerCase() === oldImpl.address.toLowerCase()
          )
        ) {
          facetCuts.push(facetCut);
        }
      }
    }

    for (const oldFacet of oldFacets) {
      if (
        !facetSnapshot.find(
          f =>
            f.facetAddress.toLowerCase() === oldFacet.facetAddress.toLowerCase()
        )
      ) {
        changesDetected = true;
        facetCuts.unshift({
          facetAddress: "0x0000000000000000000000000000000000000000",
          functionSelectors: oldFacet.functionSelectors
        });
      }
    }

    let data = "0x";
    if (options.execute) {
      const diamondContract = new Contract(
        "0x0000000000000000000000000000000000000001",
        abi
      );
      const txData = await diamondContract.populateTransaction[
        options.execute.methodName
      ](...options.execute.args);
      data = txData.data || "0x";
    }

    if (changesDetected) {
      if (!proxy) {
        // ensure a Diamantaire exists on the network :
        const diamantaireName = "Diamantaire";
        let diamantaireDeployment = await getDeploymentOrNUll(diamantaireName);
        diamantaireDeployment = await _deployOne(diamantaireName, {
          contract: diamantaire,
          from: options.from,
          deterministicDeployment: true
        });
        const diamantaireContract = new Contract(
          diamantaireDeployment.address,
          diamantaire.abi,
          provider
        );
        // the diamantaire allow the execution of data at diamond construction time

        let salt =
          "0x0000000000000000000000000000000000000000000000000000000000000000";
        if (typeof options.deterministicSalt !== "undefined") {
          if (typeof options.deterministicSalt === "string") {
            if (options.deterministicSalt === salt) {
              throw new Error(
                `deterministicSalt cannot be 0x000..., it needs to be a non-zero bytes32 salt. This is to ensure you are explicitly specyfying different addresses for multiple diamonds`
              );
            } else {
              if (options.deterministicSalt.length !== 66) {
                throw new Error(
                  `deterministicSalt needs to be a string of 66 hexadecimal characters (including the 0x prefix)`
                );
              }
              salt = options.deterministicSalt;
            }
          } else {
            throw new Error(
              `deterministicSalt need to be a string, an non-zero bytes32 salt`
            );
          }
        }
        const createReceipt = await execute(
          diamantaireName,
          options,
          "createDiamond",
          owner,
          facetCuts,
          data,
          salt
        );

        if (!createReceipt) {
          throw new Error(`failed to get receipt from diamond creation`);
        }

        const events = [];
        if (createReceipt.logs) {
          for (const l of createReceipt.logs) {
            try {
              events.push(diamantaireContract.interface.parseLog(l));
            } catch (e) {}
          }
        }

        const diamondCreatedEvent = events.find(
          e => e.name === "DiamondCreated"
        );
        if (!diamondCreatedEvent) {
          throw new Error("DiamondCreated Not Emitted");
        }
        const proxyAddress = diamondCreatedEvent.args.diamond;
        if (options.log) {
          log(
            `Diamond deployed at ${proxyAddress} via Diamantaire (${diamantaireDeployment.address}) cuts: ${facetCuts} with ${createReceipt.gasUsed} gas`
          );
        }

        if (
          salt !==
          "0x0000000000000000000000000000000000000000000000000000000000000000"
        ) {
          const expectedAddress = getCreate2Address(
            diamantaireContract.address,
            solidityKeccak256(["bytes32", "address"], [salt, owner]),
            diamondBase.bytecode +
              "000000000000000000000000" +
              diamantaireContract.address.slice(2)
          );
          if (expectedAddress !== proxyAddress) {
            throw new Error(
              `unexpected address ${proxyAddress} VS ${expectedAddress}`
            );
          }
        }

        proxy = {
          abi: diamondBase.abi,
          address: proxyAddress,
          receipt: createReceipt,
          transactionHash: createReceipt.transactionHash,
          args: [owner],
          bytecode: diamondBase.bytecode,
          deployedBytecode: diamondBase.deployedBytecode,
          metadata: diamondBase.metadata
          // TODO if more fiels are added, we need to add more
        };
        await env.deployments.save(proxyName, proxy);

        await env.deployments.save(name, {
          address: proxy.address,
          receipt: proxy.receipt,
          transactionHash: proxy.transactionHash,
          linkedData: options.linkedData,
          facets: facetSnapshot,
          diamondCut: facetCuts,
          abi,
          execute: options.execute
          // metadata: diamondBase.metadata
        });
      } else {
        if (!oldDeployment) {
          throw new Error(`Cannot find Deployment for ${name}`);
        }
        const currentOwner = await read(proxyName, "owner");
        if (currentOwner.toLowerCase() !== owner.toLowerCase()) {
          throw new Error(`The Diamond owner is not ${owner}`);
        }

        const executeReceipt = await execute(
          name,
          options,
          "diamondCut",
          facetCuts,
          data === "0x"
            ? "0x0000000000000000000000000000000000000000"
            : proxy.address,
          data
        );
        if (!executeReceipt) {
          throw new Error("failed to execute");
        }
        await env.deployments.save(name, {
          receipt: executeReceipt,
          transactionHash: executeReceipt.transactionHash,
          history: oldDeployment.history
            ? oldDeployment.history.concat(oldDeployment)
            : [oldDeployment],
          linkedData: options.linkedData,
          address: proxy.address,
          abi,
          facets: facetSnapshot,
          diamondCut: facetCuts,
          execute: options.execute
          // metadata: oldDeployment.metadata
        });
      }

      const deployment = await env.deployments.get(name);
      return {
        ...deployment,
        newlyDeployed: true
      };
    } else {
      const deployment = await env.deployments.get(name);
      return {
        ...deployment,
        newlyDeployed: false
      };
    }
  }

  async function deploy(
    name: string,
    options: DeployOptions
  ): Promise<DeployResult> {
    await init();
    if (!options.proxy) {
      return _deployOne(name, options);
    }
    return _deployViaTransparentProxy(name, options);
  }

  async function diamond(
    name: string,
    options: DiamondOptions
  ): Promise<DeployResult> {
    await init();
    return _deployViaDiamondProxy(name, options);
  }

  async function rawTx(tx: SimpleTx): Promise<Receipt> {
    await init();
    const { address: from, ethersSigner } = getFrom(tx.from);
    if (!ethersSigner) {
      throw new UnknownSignerError({
        from,
        to: tx.to,
        data: tx.data,
        value: tx.value
      });
    } else {
      const transactionData = {
        to: tx.to,
        gasLimit: tx.gasLimit,
        gasPrice: tx.gasPrice ? BigNumber.from(tx.gasPrice) : undefined, // TODO cinfig
        value: tx.value ? BigNumber.from(tx.value) : undefined,
        nonce: tx.nonce,
        data: tx.data
      };
      let pendingTx = await ethersSigner.sendTransaction(transactionData);
      pendingTx = await onPendingTx(pendingTx);
      if (tx.dev_forceMine) {
        try {
          await provider.send("evm_mine", []);
        } catch (e) {}
      }
      return pendingTx.wait();
    }
  }

  async function catchUnknownSigner(
    action: Promise<any> | (() => Promise<any>)
  ): Promise<void> {
    try {
      if (action instanceof Promise) {
        await action;
      } else {
        await action();
      }
    } catch (e) {
      if (e instanceof UnknownSignerError) {
        const { from, to, data, value, contract } = e.data;
        console.error("no signer for " + from);
        if (contract) {
          console.log(`Please execute the following on ${contract.name}`);
          console.log(
            `
from: ${from}
to: ${to}
value: ${value ? (typeof value === "string" ? value : value.toString()) : "0"}
data: ${data}
`
          );
          console.log("if you have an interface use the following");
          console.log(
            `
from: ${from}
to: ${to} (${contract.name})
value: ${value}
method: ${contract.method}
args: [${contract.args.join(",")}]
`
          );
        } else {
          console.log(`Please execute the following`);
          console.log(
            `
from: ${from}
to: ${to}
value: ${value ? (typeof value === "string" ? value : value.toString()) : "0"}
data: ${data}
`
          );
        }
      } else {
        throw e;
      }
    }
  }

  async function execute(
    name: string,
    options: TxOptions,
    methodName: string,
    ...args: any[]
  ): Promise<Receipt> {
    await init();
    const { address: from, ethersSigner } = getFrom(options.from);

    let tx;
    const deployment = await env.deployments.get(name);
    const abi = deployment.abi;
    const overrides = {
      gasLimit: options.gasLimit,
      gasPrice: options.gasPrice ? BigNumber.from(options.gasPrice) : undefined, // TODO cinfig
      value: options.value ? BigNumber.from(options.value) : undefined,
      nonce: options.nonce
    };

    const ethersContract = new Contract(
      deployment.address,
      abi,
      (ethersSigner as Signer) || provider
    );
    if (!ethersContract.functions[methodName]) {
      throw new Error(
        `No method named "${methodName}" on contract deployed as "${name}"`
      );
    }

    const numArguments = ethersContract.interface.getFunction(methodName).inputs
      .length;
    if (args.length !== numArguments) {
      throw new Error(
        `expected ${numArguments} arguments for method "${methodName}", got ${args.length}`
      );
    }

    if (!ethersSigner) {
      const ethersArgs = args ? args.concat([overrides]) : [overrides];
      const { data } = await ethersContract.populateTransaction[methodName](
        ...ethersArgs
      );
      throw new UnknownSignerError({
        from,
        to: deployment.address,
        data,
        value: options.value,
        contract: {
          name,
          method: methodName,
          args
        }
      });
    } else {
      await overrideGasLimit(overrides, options, newOverrides => {
        const ethersArgsWithGasLimit = args
          ? args.concat([newOverrides])
          : [newOverrides];
        return ethersContract.estimateGas[methodName](
          ...ethersArgsWithGasLimit
        );
      });
      await setupGasPrice(overrides);
      const ethersArgs = args ? args.concat([overrides]) : [overrides];
      tx = await ethersContract.functions[methodName](...ethersArgs);
    }
    tx = await onPendingTx(tx);

    if (options.log) {
      print(`executing ${name}.${methodName}... `);
    }

    if (options.dev_forceMine) {
      try {
        await provider.send("evm_mine", []);
      } catch (e) {}
    }
    const receipt = await tx.wait();
    if (options.log) {
      print(`: performed with ${receipt.gasUsed} gas\n`);
    }
    return receipt;
  }

  // TODO ?
  // async function rawCall(to: string, data: string) {
  //   // TODO call it eth_call?
  //   await init();
  //   return provider.send("eth_call", [
  //     {
  //       to,
  //       data
  //     },
  //     "latest"
  //   ]); // TODO overrides
  // }

  async function read(
    name: string,
    options: CallOptions | string,
    methodName?: string | any,
    ...args: unknown[]
  ) {
    await init();
    if (typeof options === "string") {
      if (typeof methodName !== "undefined") {
        args.unshift(methodName);
      }
      methodName = options;
      options = {};
    }
    if (typeof args === "undefined") {
      args = [];
    }
    let caller: Web3Provider | Signer = provider;
    const { ethersSigner } = getOptionalFrom(options.from);
    if (ethersSigner) {
      caller = ethersSigner;
    }
    const deployment = await env.deployments.get(name);
    if (!deployment) {
      throw new Error(`no contract named "${name}"`);
    }
    const abi = deployment.abi;
    const overrides: PayableOverrides = {
      gasLimit: options.gasLimit,
      gasPrice: options.gasPrice ? BigNumber.from(options.gasPrice) : undefined, // TODO cinfig
      value: options.value ? BigNumber.from(options.value) : undefined,
      nonce: options.nonce
    };
    const ethersContract = new Contract(
      deployment.address,
      abi,
      caller as Signer
    );
    // populate function
    // if (options.outputTx) {
    //   const method = ethersContract.populateTransaction[methodName];
    //   if (!method) {
    //     throw new Error(
    //       `no method named "${methodName}" on contract "${name}"`
    //     );
    //   }
    //   if (args.length > 0) {
    //     return method(...args, overrides);
    //   } else {
    //     return method(overrides);
    //   }
    // }
    const method = ethersContract.callStatic[methodName];
    if (!method) {
      throw new Error(`no method named "${methodName}" on contract "${name}"`);
    }
    if (args.length > 0) {
      return method(...args, overrides);
    } else {
      return method(overrides);
    }
  }

  const extension: DeploymentsExtension = {
    ...partialExtension,
    fetchIfDifferent,
    deploy,
    diamond: {
      deploy: diamond
    },
    catchUnknownSigner,
    execute,
    rawTx,
    read,
    deterministic
  };

  // ////////// Backward compatible for transition: //////////////////
  (extension as any).call = (
    options: any,
    name: string,
    methodName: string,
    ...args: any[]
  ): Promise<any> => {
    if (typeof options === "string") {
      args = args || [];
      if (methodName !== undefined) {
        args.unshift(methodName);
      }
      methodName = name;
      name = options;
      options = {};
    }
    return read(name, options, methodName, ...args);
  };

  (extension as any).sendTxAndWait = (
    options: TxOptions,
    name: string,
    methodName: string,
    ...args: any[]
  ): Promise<Receipt | null> => {
    return execute(name, options, methodName, ...args);
  };

  (extension as any).deployIfDifferent = (
    fieldsToCompare: string | string[],
    name: string,
    options: DeployOptions,
    contractName: string,
    ...args: any[]
  ): Promise<DeployResult> => {
    options.fieldsToCompare = fieldsToCompare;
    options.contract = contractName;
    options.args = args;
    return deploy(name, options);
  };
  // ////////////////////////////////////////////////////////////////////

  return extension;
}

function pause(duration: number): Promise<void> {
  return new Promise(res => setTimeout(res, duration * 1000));
}

export async function waitForTx(
  ethereum: EthereumProvider,
  txHash: string,
  isContract: boolean
) {
  let receipt;
  while (true) {
    try {
      receipt = await ethereum.send("eth_getTransactionReceipt", [txHash]);
    } catch (e) {}
    if (receipt && receipt.blockNumber) {
      if (isContract) {
        if (!receipt.contractAddress) {
          throw new Error("contract not deployed");
        } else {
          return receipt;
        }
      } else {
        return receipt;
      }
    }
    await pause(2);
  }
}
