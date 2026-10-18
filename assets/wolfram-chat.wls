(* Fixed bridge: input is imported as JSON data, never evaluated as Wolfram code. *)
request = Quiet@Check[Import[Last[$ScriptCommandLine], "RawJSON"], $Failed];
If[!AssociationQ[request], Print["{\"type\":\"error\",\"message\":\"Invalid request file\"}"]; Exit[1]];
result = Quiet@Check[
  If[Lookup[request, "model", "default"] === "default",
    LLMSynthesize[request["prompt"]],
    LLMSynthesize[request["prompt"], LLMEvaluator -> request["model"]]
  ], $Failed];
If[!StringQ[result],
  Print["{\"type\":\"error\",\"message\":\"Wolfram LLM request failed. Configure LLM access in your Wolfram installation.\"}"]; Exit[1],
  Print[ExportString[<|"type" -> "result", "text" -> result|>, "RawJSON", "Compact" -> True]]
];
