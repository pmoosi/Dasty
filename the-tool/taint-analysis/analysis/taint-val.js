// DO NOT INSTRUMENT

const {isAnalysisProxy, iidToLocation} = require("../utils/utils");
const STRING_AND_ARRAY_PROPS = Object.getOwnPropertyNames(String.prototype)
    .filter(strProp => strProp in Array.prototype);

// console.log(STRING_AND_ARRAY_PROPS);

class TaintProxyHandler {
    __isAnalysisProxy = true;

    constructor(sourceIID, prop, entryPoint, undef = true, val = null, type = null) {
        this.__taint = sourceIID ? {source: {iid: sourceIID, prop}, entryPoint, codeFlow: []} : null;
        this.__undef = undef;

        this.#type = type;
        this.__val = val ?? this.__getDefaultVal(type);
    }

    #type = null;

    get __type() {
        return this.#type;
    }

    set __type(type) {
        if (type === this.#type) return;

        this.#type = type;
        this.__val = this.__getDefaultVal(type);
    }

    __setValue(val) {
        if (val !== undefined) {
            this.__type = getTypeOf(val);
        }
        this.__val = val;
        this.__undef = val === undefined;
    }

    __getDefaultVal(type) {
        // ToDo - boolean, symbol, bigint?
        switch (type) {
            case 'number':
                return 0;
            case 'array':
                return [];
            case 'function':
                return () => {
                };
            case 'boolean':
                return true;
            case 'object':
                return {};
            default:
                return ' ';
        }
    }

    __typeof() {
        // ToDo - boolean, symbol, bigint?
        switch (this.__type) {
            case null:
            case 'string':
                return 'string';
            case 'number':
                return 'number';
            case 'boolean':
                return 'boolean';
            case 'function':
                return 'function';
            default:
                return 'object';
        }
    }

    /**
     * Handles the access of properties that should exist (e.g. substring for strings) by returning either a 'wrapper' function or the property
     * @param objType - the inferred type of the wrapped object (e.g. map implies array)
     * @param prop - the property that is accessed
     * @param isFun - an indicator if a function is expected
     * @returns {{}|any} - returns either a wrapper function or the property value
     * @private
     */
    __handleDefaultPropAccess(objType, prop, isFun) {
        this.__type = objType;

        if (isFun) {
            // return function that is called instead of the original one
            return function () {
                // check if the method changes the underlying object (currently only array length check support)
                // ToDo - add check for other objects and functions (e.g. sort)
                const preLength = this.__type === 'array' ? this.__val.length : null;

                const newVal = this.__val[prop](...arguments);

                if (this.__type === 'array' && this.__val.length !== preLength) {
                    // record side effects (e.g. Array.push)
                    this.__taint.codeFlow.push(createCodeFlow(null, 'functionSideEffect', prop));
                }

                // ToDo - maybe don't propagate taint if function returns only boolean or int (e.g. Array.push)?
                // but in theory it might be possible to overwrite these methods to return something else so I'm keeping it for now
                return this.__copyTaint(newVal, createCodeFlow(null, 'functionResult', prop), getTypeOf(newVal));
            }.bind(this);
        }

        // if no function simply return the property value
        const newVal = this.__val[prop];
        return this.__copyTaint(newVal, createCodeFlow(null, 'propRead', prop), getTypeOf(newVal));
    }

    __getArrayElem(index) {
        this.__type = 'array';

        // inject new taint value if access is undefined
        // ToDo - think about if we should taint every access (it might not always be true -> e.g. if was set after the pollution)
        if (index >= this.__val.length) {
            const cf = createCodeFlow(null, 'arrayElemRead', index);
            return this.__copyTaint(null, cf, null, true);
        } else {
            return this.__val[index];
        }
    }

    /**
     * Creates a copy of a taint value with an optional new value and an added codeFlow
     * @param newVal - an optional new value, if not set the old one is used
     * @param codeFlow - an optional codeFlow to add
     * @param type - an optional type for the injected value
     * @param undef - an optional indicator if the value correspond to undefined
     * @returns {{}} - the new TaintVal with the copied data
     */
    __copyTaint(newVal = undefined, codeFlow = undefined, type = undefined, undef = this.__undef) {
        const taintHandler = new TaintProxyHandler(
            null,
            null,
            null,
            undef,
            newVal ?? this.__val,
            type !== undefined ? type : this.__type
        );

        // copy the taint
        try {
            taintHandler.__taint = structuredClone(this.__taint);
        } catch (e) {
            console.log(this.__taint);
            throw e;
        }
        // add codeFlow
        if (codeFlow) {
            taintHandler.__taint.codeFlow.push(codeFlow);
        }
        return new Proxy(() => {
        }, taintHandler);
    }

    // Convert to primitive
    valueOf() {
        // it might not have value of (e.g. null prototype object)
        return this.__val.valueOf ? this.__val?.valueOf() : this.__val;
    }

    toString() {
        return this.__val.toString ? this.__val?.toString() : this.__val;
    }

    /**
     * Function that handles the '+' operation by joining taint
     * @param iid
     * @param val - the value which is added to the tainted value
     * @param result - the actual result of the operation
     * @param isLeft - indicator if the obj is on the left or right hand side of the operation
     * @returns {{}}
     * @private
     */
    __add(iid, val, result, isLeft = true) {
        // we now know that the type of the value is either number or string (for now default to string ToDo)
        if (this.__type === null) {
            this.__type = 'string';
        }

        const cf = createCodeFlow(
            iid,
            'binary',
            'add' + (isLeft ? 'Right' : 'Left'),
            [val?.__taint ?? val]
        );

        const type = typeof result === 'number' ? 'number' : 'string';
        return this.__copyTaint(result, cf, type);
    }

    __addCodeFlow(iid, type, name, values = undefined, inferredType = null) {
        if (inferredType && this.__type !== null && this.__type !== 'non-primitive') {
            this.__type = inferredType;
        }

        const cf = createCodeFlow(iid, type, name, values);
        this.__taint.codeFlow.push(cf);
    }

    __getFlowSource() {
        const taint = structuredClone(this.__taint);
        taint.source.inferredType = this.__type;
        return taint;
    }

    // Proxy traps

    /**
     * Traps all property accesses
     * @param target - the proxied object (unused)
     * @param prop - the property name that is accessed
     * @param receiver - the proxy object (unused)
     * @returns {any|{}}
     */
    get(target, prop, receiver) {
        // ToDo
        if (prop === 'constructor') {
            return Reflect.get(target, prop, receiver);
        } else if (this.hasOwnProperty(prop) || TaintProxyHandler.prototype.hasOwnProperty(prop)) {
            // if the property is defined in the class delegate to it (this makes it straightforward to overwrite specific functions/members)
            return typeof this[prop] === 'function' ? this[prop].bind(this) : this[prop];
        } else if (typeof prop === 'symbol') {
            // ToDo - handle symbol access
            return undefined;
            // return this.__val[prop] ? this.__val[prop] : undefined;
        } else if (this.__type === null && STRING_AND_ARRAY_PROPS.includes(prop)) {
            return this.__handleDefaultPropAccess(null, prop, typeof String.prototype[prop] === 'function');
        } else if (this.__type === 'string' || (this.__type === null && prop in String.prototype)) {
            return this.__handleDefaultPropAccess('string', prop, typeof String.prototype[prop] === 'function');
        } else if (this.__type === 'array' || (this.__type === null && prop in Array.prototype)) {
            return this.__handleDefaultPropAccess('array', prop, typeof Array.prototype[prop] === 'function');
        } else {
            // handle all other property accesses

            // if the property exists copy it -> else set it to null (i.e. 'unknown')
            const newVal = this.__val[prop] ?? null;

            // if already tainted simply return it
            if (isAnalysisProxy(newVal) && newVal?.__taint) {
                return newVal;
            }

            const type = getTypeOf(newVal);
            const cf = createCodeFlow(null, 'propRead', prop);

            // ToDo - check blacklist

            // don't inject directly - this can lead to unwanted behavior and does not have any new information as we already track the taint via the base
            return this.__copyTaint(newVal, cf, type, newVal === undefined);
        }
    }

    set(target, prop, value, receiver) {
        if (this.hasOwnProperty(prop) || TaintProxyHandler.prototype.hasOwnProperty(prop)) {
            this[prop] = value;
            return true;
        }

        return Reflect.set(target, prop, value, receiver);
    }

    /** Traps function call (i.e. proxy(...)) */
    apply(target, thisArg, argumentList) {
        // Return a new tainted value with unknown type and null as value
        this.__type = 'function';
        const cf = createCodeFlow(null, 'functionCall', '');
        return this.__copyTaint(null, cf, null, false);
    }
}

/**
 * Gets the type of a value; basically 'typeof' with additional type 'array' and without 'undefined'
 * @param val
 * @returns {string|"undefined"|"object"|"boolean"|"number"|"string"|"function"|"symbol"|"bigint"|"array"|null}
 * @private
 */
function getTypeOf(val) {
    if (val === undefined) return null;

    let tpe = typeof val;
    return tpe === 'object' && val instanceof Array ? 'array' : tpe;
}

function createCodeFlow(iid, type, name, values = undefined) {
    const transformation = {iid, type, name};
    if (values) {
        transformation.values = values;
    }
    return transformation;
}

function createTaintVal(sourceIID, prop, entryPoint, undef = true, val = null, type = null) {
    const handler = new TaintProxyHandler(sourceIID, prop, entryPoint, undef, val, type);

    // the target is a function as it makes it callable while still being an object
    return new Proxy(() => {
    }, handler);
}

module.exports = {createTaintVal, createCodeFlow};