import * as ethUtil from '../util/eth-util';
import BN from 'bn.js';
import clone from 'clone';
import * as cacheUtils from '../util/rpc-cache-utils.js';
import Stoplight from '../util/stoplight.js';
import Subprovider from './subprovider.js';

const blockPollingMethods = [
  'eth_blockNumber',
  'eth_blockByNumber'
];

export default class BlockCacheProvider extends Subprovider {

  constructor(opts) {
    super(opts);
    const self = this;
    opts = opts || {};
    // set initialization blocker
    self._ready = new Stoplight();
    self.strategies = {
      perma: new ConditionalPermaCacheStrategy({
        eth_getTransactionByHash: containsBlockhash,
        eth_getTransactionReceipt: containsBlockhash,
      }),
      block: new BlockCacheStrategy(self),
      fork: new BlockCacheStrategy(self),
    };
  }

  // setup a block listener on 'setEngine'
  setEngine(engine) {
    const self = this;
    self.engine = engine;
    // unblock initialization after first block
    engine.once('block', function(block) {
      self.currentBlock = block;
      self._ready.go();
      // from now on, empty old cache every block
      engine.on('block', clearOldCache);
    });

    function clearOldCache(newBlock) {
      var previousBlock = self.currentBlock;
      self.currentBlock = newBlock;
      if (!previousBlock) return;
      self.strategies.block.cacheRollOff(previousBlock);
      self.strategies.fork.cacheRollOff(previousBlock);
    }
  }

  handleRequest(payload, next, end) {
    const self = this;

    // skip cache if told to do so
    if (payload.skipCache) {
      // console.log('CACHE SKIP - skip cache if told to do so')
      return next();
    }

    // Ignore requests for the latest block
    if (payload.method === 'eth_getBlockByNumber' && payload.params[0] === 'latest') {
      // console.log('CACHE SKIP - Ignore block polling requests.')
      return next();
    }

    // wait for first block
    self._ready.await(function(){
      // actually handle the request
      self._handleRequest(payload, next, end);
    });
  }

  _handleRequest(payload, next, end){
    const self = this;

    var type = cacheUtils.cacheTypeForPayload(payload);
    var strategy = this.strategies[type];

    // If there's no strategy in place, pass it down the chain.
    if (!strategy) {
      return next();
    }

    // If the strategy can't cache this request, ignore it.
    if (!strategy.canCache(payload)) {
      return next();
    }

    var blockTag = cacheUtils.blockTagForPayload(payload);
    if (!blockTag) blockTag = 'latest';
    var requestedBlockNumber;

    if (blockTag === 'earliest') {
      requestedBlockNumber = '0x00';
    } else if (blockTag === 'latest') {
      requestedBlockNumber = ethUtil.bufferToHex(self.currentBlock.number);
    } else {
      // We have a hex number
      requestedBlockNumber = blockTag;
    }

    //console.log('REQUEST at block 0x' + requestedBlockNumber.toString('hex'))

    // end on a hit, continue on a miss
    strategy.hitCheck(payload, requestedBlockNumber, end, function() {
      // miss fallthrough to provider chain, caching the result on the way back up.
      next(function(err, result, cb) {
        // err is already handled by engine
        if (err) return cb();
        strategy.cacheResult(payload, result, requestedBlockNumber, cb);
      });
    });
  }
}

//
// Cache Strategies
//

class PermaCacheStrategy {

  constructor() {
    var self = this;
    self.cache = {};
    // clear cache every ten minutes
    var timeout = setInterval(function(){
      self.cache = {};
    }, 10 * 60 * 1e3);
    // do not require the Node.js event loop to remain active
    if (timeout.unref) timeout.unref();
  }

  hitCheck(payload, requestedBlockNumber, hit, miss) {
    var identifier = cacheUtils.cacheIdentifierForPayload(payload);
    var cached = this.cache[identifier];

    if (!cached) return miss();

    // If the block number we're requesting at is greater than or
    // equal to the block where we cached a previous response,
    // the cache is valid. If it's from earlier than the cache,
    // send it back down to the client (where it will be recached.)
    var cacheIsEarlyEnough = compareHex(requestedBlockNumber, cached.blockNumber) >= 0;
    if (cacheIsEarlyEnough) {
      var clonedValue = clone(cached.result);
      return hit(null, clonedValue);
    } else {
      return miss();
    }
  }

  cacheResult(payload, result, requestedBlockNumber, callback) {
    var identifier = cacheUtils.cacheIdentifierForPayload(payload);

    if (result) {
      var clonedValue = clone(result);
      this.cache[identifier] = {
        blockNumber: requestedBlockNumber,
        result: clonedValue,
      };
    }

    callback();
  }

  canCache(payload) {
    return cacheUtils.canCache(payload);
  }
}

//
// ConditionalPermaCacheStrategy
//

class ConditionalPermaCacheStrategy {

  constructor(conditionals) {
    this.strategy = new PermaCacheStrategy();
    this.conditionals = conditionals;
  }

  hitCheck(payload, requestedBlockNumber, hit, miss) {
    return this.strategy.hitCheck(payload, requestedBlockNumber, hit, miss);
  }

  cacheResult(payload, result, requestedBlockNumber, callback) {
    var conditional = this.conditionals[payload.method];

    if (conditional) {
      if (conditional(result)) {
        this.strategy.cacheResult(payload, result, requestedBlockNumber, callback);
      } else {
        callback();
      }
    } else {
      // Cache all requests that don't have a conditional
      this.strategy.cacheResult(payload, result, requestedBlockNumber, callback);
    }
  }

  canCache(payload) {
    return this.strategy.canCache(payload);
  }
}

//
// BlockCacheStrategy
//

class BlockCacheStrategy {

  constructor() {
    this.cache = {};
  }

  getBlockCacheForPayload(payload, blockNumberHex) {
    const blockNumber = Number.parseInt(blockNumberHex, 16);
    let blockCache = this.cache[blockNumber];
    // create new cache if necesary
    if (!blockCache) {
      const newCache = {};
      this.cache[blockNumber] = newCache;
      blockCache = newCache;
    }
    return blockCache;
  }

  hitCheck(payload, requestedBlockNumber, hit, miss) {
    var blockCache = this.getBlockCacheForPayload(payload, requestedBlockNumber);

    if (!blockCache) {
      return miss();
    }

    var identifier = cacheUtils.cacheIdentifierForPayload(payload);
    var cached = blockCache[identifier];
    if (cached) {
      var clonedValue = clone(cached);
      return hit(null, clonedValue);
    } else {
      return miss();
    }
  }

  cacheResult(payload, result, requestedBlockNumber, callback) {
    if (result) {
      var blockCache = this.getBlockCacheForPayload(payload, requestedBlockNumber);
      var identifier = cacheUtils.cacheIdentifierForPayload(payload);
      var clonedValue = clone(result);
      blockCache[identifier] = clonedValue;
    }
    callback();
  }

  canCache(payload) {
    if (!cacheUtils.canCache(payload)) {
      return false;
    }

    var blockTag = cacheUtils.blockTagForPayload(payload);

    return (blockTag !== 'pending');
  }

  // naively removes older block caches
  cacheRollOff(previousBlock){
    const self = this;
    const previousHex = ethUtil.bufferToHex(previousBlock.number);
    const oldBlockNumber = Number.parseInt(previousHex, 16);
    // clear old caches
    Object.keys(self.cache)
      .map(Number)
      .filter(num => num <= oldBlockNumber)
      .forEach(num => delete self.cache[num]);
  }
}

// util

function compareHex(hexA, hexB){
  var numA = parseInt(hexA, 16);
  var numB = parseInt(hexB, 16);
  return numA === numB ? 0 : (numA > numB ? 1 : -1 );
}

function hexToBN(hex){
  return new BN(ethUtil.toBuffer(hex));
}

function containsBlockhash(result) {
  if (!result) return false;
  if (!result.blockHash) return false;
  const hasNonZeroHash = hexToBN(result.blockHash).gt(new BN(0));
  return hasNonZeroHash;
}
