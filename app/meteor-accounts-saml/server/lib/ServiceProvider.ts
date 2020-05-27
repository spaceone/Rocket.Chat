import zlib from 'zlib';
import crypto from 'crypto';
import querystring from 'querystring';

import { Meteor } from 'meteor/meteor';

import { SAMLUtils } from './Utils';
import { AuthorizeRequest } from './generators/AuthorizeRequest';
import { LogoutRequest } from './generators/LogoutRequest';
import { LogoutResponse } from './generators/LogoutResponse';
import { ServiceProviderMetadata } from './generators/ServiceProviderMetadata';
import { LogoutRequestParser } from './parsers/LogoutRequest';
import { LogoutResponseParser } from './parsers/LogoutResponse';
import { ResponseParser } from './parsers/Response';
import { IServiceProviderOptions } from '../definition/IServiceProviderOptions';

export class SAMLServiceProvider {
	constructor(serviceProviderOptions: IServiceProviderOptions): void {
		this.serviceProviderOptions = this.initialize(serviceProviderOptions);
	}

	initialize(serviceProviderOptions: IServiceProviderOptions): IServiceProviderOptions {
		if (!serviceProviderOptions) {
			serviceProviderOptions = {};
		}

		if (!serviceProviderOptions.protocol) {
			serviceProviderOptions.protocol = 'https://';
		}

		if (!serviceProviderOptions.path) {
			serviceProviderOptions.path = '/saml/consume';
		}

		if (!serviceProviderOptions.issuer) {
			serviceProviderOptions.issuer = 'onelogin_saml';
		}

		return serviceProviderOptions;
	}

	signRequest(xml: string): Buffer {
		const signer = crypto.createSign('RSA-SHA1');
		signer.update(xml);
		return signer.sign(this.serviceProviderOptions.privateKey, 'base64');
	}

	generateAuthorizeRequest(host: string): string {
		const identifiedRequest = AuthorizeRequest.generate(this.serviceProviderOptions, host);
		return identifiedRequest.request;
	}

	generateLogoutResponse(): Record<string, string> {
		return LogoutResponse.generate(this.serviceProviderOptions);
	}

	generateLogoutRequest({ nameID, sessionIndex }: { nameID: string; sessionIndex: string }): Record<string, string> {
		return LogoutRequest.generate(this.serviceProviderOptions, nameID, sessionIndex);
	}

	/*
		This method will generate the response URL with all the query string params and pass it to the callback
	*/
	logoutResponseToUrl(response: string, callback: (err: object, url?: string) => void): void {
		zlib.deflateRaw(response, (err, buffer) => {
			if (err) {
				return callback(err);
			}

			const base64 = buffer.toString('base64');
			let target = this.serviceProviderOptions.idpSLORedirectURL;

			if (target.indexOf('?') > 0) {
				target += '&';
			} else {
				target += '?';
			}

			// TBD. We should really include a proper RelayState here
			const relayState = Meteor.absoluteUrl();

			const samlResponse = {
				SAMLResponse: base64,
				RelayState: relayState,
			};

			if (this.serviceProviderOptions.privateCert) {
				samlResponse.SigAlg = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1';
				samlResponse.Signature = this.signRequest(querystring.stringify(samlResponse));
			}

			target += querystring.stringify(samlResponse);

			return callback(null, target);
		});
	}

	/*
		This method will generate the request URL with all the query string params and pass it to the callback
	*/
	requestToUrl(request: string, operation: string, callback: (err: object, url?: string) => void): void {
		zlib.deflateRaw(request, (err, buffer) => {
			if (err) {
				return callback(err);
			}

			const base64 = buffer.toString('base64');
			let target = this.serviceProviderOptions.entryPoint;

			if (operation === 'logout') {
				if (this.serviceProviderOptions.idpSLORedirectURL) {
					target = this.serviceProviderOptions.idpSLORedirectURL;
				}
			}

			if (target.indexOf('?') > 0) {
				target += '&';
			} else {
				target += '?';
			}

			// TBD. We should really include a proper RelayState here
			let relayState;
			if (operation === 'logout') {
				// in case of logout we want to be redirected back to the Meteor app.
				relayState = Meteor.absoluteUrl();
			} else {
				relayState = this.serviceProviderOptions.provider;
			}

			const samlRequest = {
				SAMLRequest: base64,
				RelayState: relayState,
			};

			if (this.serviceProviderOptions.privateCert) {
				samlRequest.SigAlg = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1';
				samlRequest.Signature = this.signRequest(querystring.stringify(samlRequest));
			}

			target += querystring.stringify(samlRequest);

			SAMLUtils.log(`requestToUrl: ${ target }`);

			if (operation === 'logout') {
				// in case of logout we want to be redirected back to the Meteor app.
				return callback(null, target);
			}
			callback(null, target);
		});
	}

	getAuthorizeUrl(req: object, callback: (err: object, url?: string) => void): void {
		const request = this.generateAuthorizeRequest(req.headers.host);
		SAMLUtils.log('-----REQUEST------');
		SAMLUtils.log(request);

		this.requestToUrl(request, 'authorize', callback);
	}

	validateLogoutRequest(samlRequest: object, callback: (err: object, data?: object) => void): void {
		SAMLUtils.inflateXml(samlRequest, (xml: string) => {
			const parser = new LogoutRequestParser(this.serviceProviderOptions);
			return parser.validate(xml, callback);
		}, (err: object) => {
			callback(err, null);
		});
	}

	validateLogoutResponse(samlResponse: object, callback: (err: object, inResponseTo?: string) => void): void {
		SAMLUtils.inflateXml(samlResponse, (xml: string) => {
			const parser = new LogoutResponseParser(this.serviceProviderOptions);
			return parser.validate(xml, callback);
		}, (err: object) => {
			callback(err, null);
		});
	}

	validateResponse(samlResponse: object, relayState: string, callback: (err: object, profile?: object, loggedOut?: boolean) => void): void {
		const xml = new Buffer(samlResponse, 'base64').toString('utf8');

		const parser = new ResponseParser(this.serviceProviderOptions);
		return parser.validate(xml, callback);
	}

	generateServiceProviderMetadata(callbackUrl: string): string {
		return ServiceProviderMetadata.generate(this.serviceProviderOptions, callbackUrl);
	}
}