type ScalyResult<ReturnValue, Error_ = string> = AsyncGenerator<
	Error_ | undefined,
	ReturnValue | void,
	ReturnValue
>;

type BoxedTupleTypes<T extends any[]> = { [P in keyof T]: [T[P]] }[Exclude<
	keyof T,
	keyof any[]
>];

type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends (
	k: infer I
) => void
	? I
	: never;

type UnboxIntersection<T> = T extends { 0: infer U } ? U : never;

declare function scaly<
	T,
	S extends any[],
	U = T & UnboxIntersection<UnionToIntersection<BoxedTupleTypes<S>>>
>(
	target: T,
	...sources: S
): {
	[P in keyof U]: U[P] extends (
		...args: any[]
	) => ScalyResult<infer ReturnValue, infer Error_>
		? (
				...args: Parameters<U[P]>
		  ) => Promise<[true, ReturnValue] | [false, Error_]>
		: never;
};

export { scaly, ScalyResult };

export default scaly;
