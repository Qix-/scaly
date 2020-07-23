/*
	NOTE to any curious readers:
The "layers" in this file are for testing purposes only.
	Not only should you not use them yourself, but they aren't
	necessarily built in the most realistic way.

	More specifically, the yield/return of [result, layerID]
	(e.g. yield ['invalid token', ['pdb']]) is for the tests to
	properly assess where the result is coming from - something
	that isn't usually interesting to applications.

	The way you structure your results is ultimately up to you
	(as Scaly uses language features instead of data structure
	conventions/specifications) - by no means do you need to
	return e.g. arrays (like we do here).
*/
const assert = require('assert').strict;
const equal = assert.deepEqual;

const scaly = require('.');

function makePersistentDB() {
	const db = {
		userCount: 0,
		sessionCount: 0,
		users: {},
		sessions: {}
	};

	return {
		toString() {
			return 'pdb';
		},

		async * createSession(uid) {
			const token = db.sessionCount++;
			if (!(uid in db.users)) {
				yield [['pdb'], 'no such user ID'];
			}

			db.sessions[token] = {uid};
			return [['pdb'], token];
		},

		async * destroySession(token) {
			if (!(token in db.sessions)) {
				yield [['pdb'], 'invalid token'];
			}

			delete db.sessions[token];
			return [['pdb'], true];
		},

		async * getUID(token) {
			return db.sessions[token]
				? [['pdb'], db.sessions[token].uid]
				: yield [['pdb'], 'invalid token'];
		},

		async * getUsername(token) {
			const session = db.sessions[token];
			if (!session) {
				yield [['pdb'], 'invalid token'];
			}

			const user = db.users[session.uid];
			if (!user) {
				yield [['pdb'], 'invalid user in session'];
			}

			return [['pdb'], user.username];
		},

		async * addUser(username) {
			if (!username || typeof username !== 'string') {
				yield [['pdb'], 'invalid username (expected non-blank string)'];
			}

			const uid = db.userCount++;
			db.users[uid] = {uid, username};
			return [['pdb'], uid];
		},

		async * deleteUser(uid) {
			if (!(uid in db.users)) {
				yield [['pdb'], 'no such user ID'];
			}

			delete db.users[uid];
			return [['pdb'], true];
		}
	};
}

function makeMemoryCache(ttl) {
	// TTL here is a bit fake since it needs to be
	// deterministic for testing purposes.
	// TTL indicates how many fetches a particular
	// key has before it's removed.

	// Further, this implementation pre-warms
	// the cache with UIDs upon session creation.
	//
	// It does not cache usernames.
	// As stated in the header comment, this weird
	// design decision does not make sense outside
	// of these tests.

	const cache = new Map();

	const store = (k, v) => cache.set(k, {v, ttl});

	const load = k => {
		const record = cache.get(k);
		if (record) {
			if ((--record.ttl) === 0) {
				cache.delete(k);
			}

			return record.v;
		}
	};

	return {
		toString() {
			return 'mc';
		},

		async * createSession(uid) {
			const [trace, token] = yield;
			const key = `token:uid:${token}`;
			store(key, uid);
			trace.push('mc');
		},

		async * destroySession(token) {
			const key = `token:uid:${token}`;
			cache.delete(key);
			// No return; hand off control to the
			// next layer, but do not report back
			// here with the result.
		},

		async * getUID(token) {
			const key = `token:uid:${token}`;
			const value = load(key);
			if (value !== undefined) {
				return [['mc'], value];
			}

			const [trace, uid] = yield;
			store(key, uid);
			trace.push('mc');
		}
	};
}

const makeDB = memoryCacheTTL => {
	// Order matters!
	return scaly([
		makeMemoryCache(memoryCacheTTL || 1),
		makePersistentDB()
	]);
};

exports.createUser = async () => {
	const db = makeDB();
	equal(
		await db.addUser('qix'),
		[true, [['pdb'], 0]]
	);
};

exports.errorCreateUserEmpty = async () => {
	const db = makeDB();
	equal(
		await db.addUser(''),
		[false, [['pdb'], 'invalid username (expected non-blank string)']]
	);
};

exports.createUserMultiple = async () => {
	const db = makeDB();
	equal(
		await db.addUser('qix'),
		[true, [['pdb'], 0]]
	);
	equal(
		await db.addUser('qux'),
		[true, [['pdb'], 1]]
	);
};

exports.deleteUser = async () => {
	const db = makeDB();
	equal(
		await db.addUser('qix'),
		[true, [['pdb'], 0]]
	);
	equal(
		await db.deleteUser(0),
		[true, [['pdb'], true]]
	);
};

exports.errorDeleteUnknownUser = async () => {
	const db = makeDB();
	equal(
		await db.deleteUser(1337),
		[false, [['pdb'], 'no such user ID']]
	);
};

exports.errorCreateSessionBadUser = async () => {
	const db = makeDB();
	equal(
		await db.createSession(1337),
		[false, [['pdb'], 'no such user ID']]
	);
};

exports.createSession = async () => {
	const db = makeDB();
	equal(
		await db.addUser('qix'),
		[true, [['pdb'], 0]]
	);
	equal(
		await db.createSession(0),
		[true, [['pdb', 'mc'], 0]] // First PDB creates it, then MC caches it
	);
	equal(
		await db.destroySession(0),
		// Both PDB and MC destroy/invalid it (respectively), but MC doesn't report back (add to the trace).
		// Therefore, only 'pdb' appears in the trace.
		// This is probably not how it should be designed in the real-world, but
		// this is supposed to test the `return undefined` case, which has special
		// semantics in Scaly (not an error, but not a 'hit'/result).
		[true, [['pdb'], true]]
	);
	equal(
		await db.deleteUser(0),
		[true, [['pdb'], true]]
	);
};

exports.errorDestroyInvalidSession = async () => {
	const db = makeDB();
	equal(
		await db.destroySession(1337),
		[false, [['pdb'], 'invalid token']]
	);
};

exports.errorQueryUIDInvalidToken = async () => {
	const db = makeDB();
	equal(
		await db.getUID(1337),
		[false, [['pdb'], 'invalid token']]
	);
};

exports.errorQueryUsernameInvalidToken = async () => {
	const db = makeDB();
	equal(
		await db.getUsername(1337),
		[false, [['pdb'], 'invalid token']]
	);
};

exports.queryUID = async () => {
	const db = makeDB(2); // Serve 2 fetches from memory cache before invalidating (simulates TTL in the real-world)
	equal(
		await db.addUser('qix'),
		[true, [['pdb'], 0]]
	);
	equal(
		await db.createSession(0),
		[true, [['pdb', 'mc'], 0]]
	);
	equal(
		await db.getUID(0),
		[true, [['mc'], 0]] // Cache hit (1 left)
	);
	equal(
		await db.getUID(0),
		[true, [['mc'], 0]] // Cache hit (0 left, next hits persistence)
	);
	equal(
		await db.getUID(0),
		[true, [['pdb', 'mc'], 0]] // Hit persistence layer first, then cache
	);
	equal(
		await db.getUID(0),
		[true, [['mc'], 0]] // Value was re-warmed again
	);
};

exports.queryUsername = async () => {
	const db = makeDB(2); // Serve 2 fetches from memory cache before invalidating (simulates TTL in the real-world)
	equal(
		await db.addUser('qix'),
		[true, [['pdb'], 0]]
	);
	equal(
		await db.createSession(0),
		[true, [['pdb', 'mc'], 0]]
	);
	equal(
		await db.getUID(0),
		[true, [['mc'], 0]] // Cache hit
	);
	equal(
		await db.getUsername(0),
		[true, [['pdb'], 'qix']]
	);
};
