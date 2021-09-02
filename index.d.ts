type ScalyResult<Ret, Err = string> = AsyncGenerator<Err | undefined, Ret | void, Ret>;

type BoxedTupleTypes<T extends any[]> =
	{ [P in keyof T]: [T[P]] }[Exclude<keyof T, keyof any[]>];

type UnionToIntersection<U> =
	(U extends any ? (k: U) => void : never) extends ((k: infer I) => void) ? I : never;

type UnboxIntersection<T> = T extends { 0: infer U } ? U : never;

declare function scaly<
	T,
	S extends any[],
	U = T & UnboxIntersection<UnionToIntersection<BoxedTupleTypes<S>>>
>(
	target: T,
	...sources: S
): {
	[P in keyof U]: U[P] extends (...args: any[]) => ScalyResult<infer Ret, infer Err>
		? (...args: Parameters<U[P]>) => Promise<[true, Ret] | [false, Err]>
		: never
};

export {
	scaly,
	ScalyResult
};

export default scaly;
