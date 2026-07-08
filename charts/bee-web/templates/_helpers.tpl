{{- define "bee-web.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "bee-web.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "bee-web.name" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "bee-web.containerName" -}}
{{- default (include "bee-web.name" .) .Values.container.name -}}
{{- end -}}

{{- define "bee-web.configPath" -}}
{{- printf "%s/%s" .Values.config.mountPath .Values.config.fileName -}}
{{- end -}}
