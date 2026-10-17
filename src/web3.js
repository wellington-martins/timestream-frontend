export const TIME_TOKEN_ADDRESS = "0x9492443b4E8d9ba1c31eE2bfaE669509E68709df";

export const TIME_TOKEN_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function faucet(address to, uint256 amount) external"
];