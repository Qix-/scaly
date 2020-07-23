# Scaly

Simple and minimal database/request/cache layering.

**Scaly** facilitates layered data access APIs through the use of async generator
functions. Yes, those really exist.

## Installation

```console
$ npm install --save scaly
```
## Usage

Inspired by CPU caching, applications can build out data access layers for various
data sources (memory caches, Redis/Etcd connections, MongoDB/MySQL/etc. persistent stores)
and facilitate the propagation of data back up the chain in the event of misses.

That's a lot of buzzwords - here's an example problem that Scaly solves:

- You have a database where an Employee ID number is associated with their First Name.
- In the most common case, that name isn't going to be updated frequently - if ever.
- Not only is it not updated frequently, but you have to look up the First Name often, hammering your database (MongoDB, for example).
- You set up a key/value store (e.g. Redis) to cache the entries - maybe with an hour TTL by default.
- You'd also like a per-service-instance memory cache with extremely low TTLs (in the order of seconds) for many subsequent requests, too.

Your code might look something like this:

```javascript
const db = /* ... */;
const redis = /* ... */;
const lru = new LRU({ttl: 10 /*seconds*/});

async function getFirstNameFromMongo(eid) {
	return db.collections('employees').findOne({eid}, {first_name: 1});
}

async function getFirstNameFromRedis(eid) {
	return redis.get(`employee:${eid}:first_name`);
}

async function setFirstNameInRedis(eid, username) {
	return redis.setex(`employee:${eid}:first_name`, 3600, username); // expire in an hour
}

function getFirstNameFromMemcache(eid) {
	return lru.get(`employee:${eid}:first_name`, username);
}

function setFirstNameInMemcache(eid, username) {
	lru.set(`employee:${eid}:first_name`, username);
}

export async function getFirstName(eid) {
	const memcache_value = getFirstNameFromMemcache(eid);
	if (memcache_value !== undefined) return memcache_value;

	const redis_value = await getFirstNameFromRedis(eid);
	if (redis_value !== undefined) {
		setFirstNameInMemcache(eid, redis_value);
		return redis_value;
	}

	const mongo_value = await getFirstNameFromMongo(eid);
	if (mongo_value !== undefined) {
		setFirstNameInMemcache(eid, redis_value);
		await setFirstNameInRedis(eid, redis_value);
		return mongo_value;
	}

	return undefined; // or error? see notes below about why this is tricky.
}
```

That's a lot of code. Here are some problems:

- This is **one** API call. There are a lot of branches, very unclear code,
  and the repeating of e.g. the `setUsernameInMemcache()` duplicate call
  can lead to bugs (especially if you inlined the `set/getUsernameInXXX()`
  functions).
- The control flow is hard to follow. This is a simple getter from multiple
  data stores - anything more complicated will result in even more code.
- It's not extensible. Adding a new data source requires surgical changes
  to existing APIs that cannot be individually tested (easily, at least
  without _extensive_ fragmentation).
- Multiply this code by 100x. That's a conservative number of datastore
  operations a medium-sized application might have.
- Error handling is ambiguous - do you return an error value, or throw
  an exception? How do I differentiate between user (request) error (e.g.
  requesting an invalid ID) and an internal error (e.g. connection was
  reset, invalid database credentials, etc.)?
- RedisLabs just went down. There's a bug in the fault-tolerant Redis
  implementation and now any attempts at getting cached values fail.
  Our upstream outage just turned into a downstream outage. We need to
  re-deploy without any Redis implementation and fall-back to just
  memcache and mongo. How do you do this when you have 100x callsites
  that need to be modified?

Along with a host of other issues.

Scaly helps alleviate these issues:

```javascript
const scaly = require('scaly');

const db = /* ... */;
const redis = /* ... */;
const lru = new LRU({ttl: 10 /*seconds*/});

const mongoLayer = {
	async *getFirstNameByEid(eid) {
		const value = await db.collection('employees').findOne({eid}, {first_name: 1});
		return value || yield 'EID not found'; // error message
	}
};

const redisLayer = {
	async *getFirstNameByEid(eid) {
		const key = `employee:${eid}:first_name`;
		return (await redis.get(key)) || redis.setex(key, 3600, yield);
	}
};

const memcacheLayer = {
	async *getFirstNameByEid(eid) {
		const key = `employee:${eid}:first_name`;
		return lru.get(key) || lru.set(key, yield);
	}
}

export default scaly(
	memcacheLayer, // Hit LRU first ...
	redisLayer,    // ... followed by Redis ...
	mongoLayer     // ... followed by MongoDB.
);
```

```javascript
const DB = require('./db');
// ...
try {
	/*
		Calling this for the first time will hit the LRU, then Redis, then MongoDB.
		Calling this again within the hour (but after 10 seconds) will hit the LRU, and then Redis.
		Calling this again within 10 seconds will only hit the LRU.
	*/
	const [ok, firstName] = await DB.getFirstNameByEid(1234);
	if (ok) {
		console.log('Hello,', firstName);
	} else {
		console.error('Invalid EID:', firstName); // firstName holds the error result.
	}
} catch (err) {
	console.error('internal error:', err.stack);
}
```

So, what's happening here?

- Each layer is comprised of the same (sub)set of API methods (in the example case, every layer
  has a `getFirstNameByEid(eid)` method).
- Each API method must be an async generator - i.e. `async *foo` (note the `*`). This allows both
  the `await` and `yield` keywords - the former useful for application developers, and the latter
  required for Scaly to work.
- The layer first checks if it can resolve the request. If it can, it `return`s the result.
- If it cannot resolve the request, but wants to be notified of the eventual result (e.g. for
  inserting into the cache), it can choose to use the result of a `yield` expression, which
  resolves to the result from a deeper layer.
    - `yield` will not return if an error is `yield`ed or `throw`n by another layer. 
    - The API method does NOT need to `return` in this case (the return value is ignored anyway).
      This is what makes the single-line implementation for Redis's layer above work.
- If it does _not_ care about the eventual result, it can simply `return;` or `return undefined;`.
  Scaly will move on to the next layer without notifying this layer of a result later on.
  In the event the very last (deepest) layer `return undefined`'s, an error is thrown - **all
  API methods must resolve or error at some point**.
- If the layer method wishes to raise a **recoverable or user error**, it should `yield err;` (where
  `err` is anything your application needs - a string, an `Error` object, or something else).
- If the layer method wishes to raise an **unrecoverable/exceptional error**, it should `throw`.
  This should be reserved for unrecoverable (e.g. connection lost, bad DB credentials, etc.) errors.

`scaly([layer1, layer2, layerN])` returns a new object with all of the API methods between all layers.
This means that if `layer1` has a `getFoo()` API method, and `layer2` has a `getBar()` method, the
resulting object will have both `getFoo()` and `getBar()` methods.

**Layers that do not have a method implementation are simply skipped.** This means if you wanted
to add a `setFirstNameForEid(eid, firstName)` method _only_ for MongoDB, adding it to the `mongodbLayer`
object is enough for Scaly to add it to the resulting `DB` object - calling the method will only hit
the MongoDB layer, as you'd expect.

Finally, Scaly wraps all API call results in an array result: `[ok: Boolean, result: any]`.
If a method yielded a recoverable error via `yield err;`, the Scaly API call will return `[false, err]`.
Likewise, if the API method returns a successful result via `return res;`, then the Scaly API call
will return `[true, res]`.

Any thrown errors are uncaught by Scaly - hence why they should be reserved for _really exceptional_ errors
and not any that can be generated by the user (in which case, they should be `catch`ed by the API method and
converted to a `yield err`).

# License

Copyright &copy; 2020, Josh Junon. Released under the [MIT License](LICENSE).
