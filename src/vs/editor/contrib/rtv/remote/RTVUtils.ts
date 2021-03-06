import { Process } from 'vs/editor/contrib/rtv/RTVInterfaces';
import { RTVLogger } from 'vs/editor/contrib/rtv/RTVLogger';
import { ICodeEditor } from 'vs/editor/browser/editorBrowser';

class RunpyProcess implements Process {
	constructor(private request: Promise<Response>,
		private abortController: AbortController) { }

	onStdout(fn: (data: any) => void): void {
		// TODO (How) could we use this?
	}

	onStderr(fn: (data: any) => void): void {
		this.request.catch(fn);
	}

	kill() {
		this.abortController.abort();
	}

	onExit(fn: (exitCode: any, result?: string) => void): void {
		this.request.then(
			async (response: Response) => {
				const success = (await response.status) === 200;
				const result = await response.text();
				fn(success ? 0 : 1, result);
			}
		);
	}
}

class SynthProcess implements Process {
	onStdout(fn: (data: any) => void): void {
		// TODO
	}

	onStderr(fn: (data: any) => void): void {
		// TODO
	}

	kill() {
		// TODO
	}

	onExit(fn: (exitCode: any, result?: string) => void): void {
		// TODO
	}
}

export function runProgram(program: string): Process {
	// We need this for CSRF protection on the server
	const csrfInput = document.getElementById('csrf-parameter') as HTMLInputElement;
	const csrfToken = csrfInput.value;
	const csrfHeaderName = csrfInput.name;

	const headers = new Headers();
	headers.append('Content-Type', 'text/plain;charset=UTF-8');
	headers.append(csrfHeaderName, csrfToken);

	const abortController = new AbortController();
	const promise = fetch(
		'/editor/runProgram',
		{
			method: 'POST',
			body: program,
			mode: 'same-origin',
			headers: headers,
			signal: abortController.signal
		});

	return new RunpyProcess(promise, abortController);
}

export function synthesizeSnippet(problem: string): Process {
	return new SynthProcess();
}

export function getLogger(editor: ICodeEditor): RTVLogger {
	return new RTVLogger(editor);
}

// Assuming the server is running on a unix system
export const EOL: string = '\n';
