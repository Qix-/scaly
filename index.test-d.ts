import {expectType} from 'tsd';
import scaly, {ScalyResult} from '.';

const db = {
	maxUsers: 10,
	cursor: 0,
	users: new Map<number, {username: string; messages: string[]}>(),

	async * registerUser(username: string): ScalyResult<number> {
		if (this.users.size >= this.maxUsers) {
			yield 'tooManyUsers';
		}

		const id = this.cursor++;
		this.users.set(id, {username, messages: []});
		return id;
	},

	async * getUsername(id: number): ScalyResult<string> {
		const user = this.users.get(id);
		return user ? user.username : yield 'noSuchUser';
	},

	async * getMessages(id: number): ScalyResult<string[]> {
		const user = this.users.get(id);
		return user ? user.messages.slice() : yield 'noSuchUser';
	},

	async * sendMessage(id: number, message: string): ScalyResult<null> {
		const user = this.users.get(id);
		return user ? (user.messages.push(message), null) : yield 'noSuchUser';
	},

	async * checkDBStatus(): ScalyResult<null> {
		return this.users.size < this.maxUsers ? null : yield 'tooManyUsers';
	},
};

const cache = {
	usernames: new Map<number, string>(),

	async * getUsername(id: number): ScalyResult<string> {
		const username = this.usernames.get(id);
		if (username) {
			return username;
		}

		this.usernames.set(id, yield);
	},

	async * checkCacheStatus(): ScalyResult<null> {
		return null;
	},
};

const api = scaly(db, cache);

type ScalyAPI<Res, Error_ = string> = Promise<[true, Res] | [false, Error_]>;

expectType<(username: string) => ScalyAPI<number>>(api.registerUser);
expectType<(id: number) => ScalyAPI<string>>(api.getUsername);
expectType<(id: number) => ScalyAPI<string[]>>(api.getMessages);
expectType<(id: number, message: string) => ScalyAPI<null>>(api.sendMessage);
expectType<() => ScalyAPI<null>>(api.checkDBStatus);
expectType<() => ScalyAPI<null>>(api.checkCacheStatus);
