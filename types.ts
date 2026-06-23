export type GlossaryEntry = {
	term: string;
	definition: string;
	aliases?: string[];
	pattern?: string;
	flags?: string;
	enabled?: boolean;
	source?: string;
};

export type CompiledEntry = GlossaryEntry & {
	matcher: RegExp;
};
