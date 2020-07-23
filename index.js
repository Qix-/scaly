module.exports = layers => {
	if (!Array.isArray(layers)) {
		throw new TypeError('layers must be an array');
	}

	const allOperations = new Set(layers.reduce(
		(acc, layer) => acc.concat(Object.keys(layer))
		, []));

	const DB = {};

	allOperations.forEach(op => {
		DB[op] = async (...args) => {
			const attemptedLayers = [];
			const pendingGenerators = [];

			for (const layer of layers) {
				// Does the layer have the operation?
				if (!layer[op]) {
					continue;
				}

				attemptedLayers.push(layer.toString());

				// Create generator
				const gen = layer[op](...args);

				// Run until first return/yield
				const {value: result, done} = await gen.next();

				// Did we return?
				if (done) {
					if (result !== undefined) {
						// Layer returned a value; propagate it up
						// to all other layers who asked for it.
						await Promise.all(pendingGenerators.map(
							gen => gen.next(result)
						));

						return [true, result];
					}

					// Otherwise, the layer neither generated a value, nor
					// does it care to receive the value.
					//
					// We simply move on down the chain without adding it to
					// the list of pending promises.
				} else if (result === undefined) {
					// Otherwise, the layer's op implementation is asking
					// for the result from the next-in-line layer.
					pendingGenerators.push(gen);
				} else {
					// If `yield ...;` is used, it means the layer wishes to
					// generate an error result.
					//
					// This is different than an exception in that it is not
					// "exceptional" - this is used for e.g. returning from
					// a malformed user query, invalid login credentials, etc.,
					// whereas exceptions are reserved for "internal" errors,
					// e.g. connection issues or invalid DB credentials, etc.
					return [false, result];
				}
			}

			// No layers could serve this operation!
			//
			// This scenario is treated either as a bug
			// or a configuration error, and thus we THROW
			// and do not RETURN an error result (since
			// a user cannot fix this case by changing the
			// inputs, for example).
			throw new Error(
				`operation was not handled by any configured layers: ${op} (attempted layers: ${attemptedLayers.join(', ')})`
			);
		};
	});

	return DB;
};
