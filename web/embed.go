// Package web embeds the static frontend assets into the klogs binary.
package web

import "embed"

//go:embed all:static
var Static embed.FS
